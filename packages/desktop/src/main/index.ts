import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, session, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC } from '../shared/contract'
import { registerProjectIpc } from './ipc'
import { ProjectService } from './services/project-service'
import { buildTemplateManager } from './services/template-host'

let mainWindow: BrowserWindow | null = null
let projectService: ProjectService | null = null

// 关键：必须在 userData 路径解析前设置应用名（ready 前），否则配置目录错误
app.setName('Documentor')

function isDev(): boolean {
  return !app.isPackaged && Boolean(process.env['ELECTRON_RENDERER_URL'])
}

/** 生命周期日志带时间戳：窗口莫名其妙消失时，靠它分辨是谁在什么时候关的 */
function lifecycle(message: string): void {
  console.log(`[lifecycle ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`)
}

/** 允许交给系统浏览器打开的外链协议（其余一律拦截） */
const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function openExternalSafely(rawUrl: string): void {
  try {
    const url = new URL(rawUrl)
    if (!SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) {
      console.warn('[security] 已拦截非安全协议外链:', url.protocol)
      return
    }
    void shell.openExternal(rawUrl)
  } catch {
    console.warn('[security] 已拦截无法解析的外链')
  }
}

/** 渲染层是否停留在应用自身页面（开发：dev server origin；生产：renderer 产物目录） */
function isInternalUrl(rawUrl: string): boolean {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    try {
      return new URL(rawUrl).origin === new URL(devUrl).origin
    } catch {
      return false
    }
  }
  const appRoot = pathToFileURL(join(__dirname, '../renderer')).href
  return rawUrl.startsWith(appRoot)
}

function createMainWindow(): void {
  const isMac = process.platform === 'darwin'
  const preloadPath = join(__dirname, '../preload/index.js')

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    show: false,
    // 无边框自绘标题栏（win32/linux）；macOS 用 hiddenInset + 原生红绿灯
    frame: false,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    trafficLightPosition: isMac ? { x: 16, y: 15 } : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f7f9',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      // 预加载产物只 require('electron')（contextBridge/ipcRenderer），可安全启用沙箱
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 最大化状态推送（标题栏按钮图标切换）
  const sendMaximized = (maximized: boolean): void => {
    mainWindow?.webContents.send(IPC.WindowMaximizedChanged, maximized)
  }
  mainWindow.on('maximize', () => sendMaximized(true))
  mainWindow.on('unmaximize', () => sendMaximized(false))

  // 关窗前自动保存。存不上就不关：让用户知道改动还在，而不是以为已经存好。
  mainWindow.on('close', (event) => {
    lifecycle('窗口收到关闭请求')
    const result = projectService?.saveAndCloseProject()
    if (result && !result.ok) {
      const choice = dialog.showMessageBoxSync(mainWindow as BrowserWindow, {
        type: 'error',
        title: '保存失败',
        message: '工程保存失败，现在退出会丢掉未保存的改动。',
        detail: result.error,
        buttons: ['返回编辑', '仍然退出'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      })
      if (choice === 0) event.preventDefault()
    }
  })
  mainWindow.on('closed', () => {
    lifecycle('窗口已关闭')
    mainWindow = null
  })

  // 渲染层崩了或子进程异常退出时留个痕迹：不然只看到窗口消失，分不清是关的还是崩的
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    lifecycle(`渲染进程结束：${details.reason} exitCode=${details.exitCode}`)
  })
  app.on('child-process-gone', (_event, details) => {
    lifecycle(`子进程结束：${details.type} ${details.reason}`)
  })

  // 外链：仅安全协议交给系统浏览器，窗口内一律不打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })

  // 导航守卫：阻止渲染层被导航到应用自身以外的地址（点击链接/脚本跳转）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault()
      openExternalSafely(url)
    }
  })

  // 本应用不使用 webview，一律拒绝挂载
  mainWindow.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })

  // 冒烟运行时转发渲染层「警告/错误」与 CSP 违规，使无头验收能观察到
  // "页面看似正常但被 CSP 拦截"的情况（DOC_E2E 只有冒烟会设，与产品逻辑无关）。
  if (process.env['DOC_E2E']) {
    mainWindow.webContents.on('console-message', (details) => {
      const isCsp = /content security policy/i.test(details.message)
      if (details.level === 'warning' || details.level === 'error' || isCsp) {
        console.log(
          `[renderer:${details.level}${isCsp ? '/csp' : ''}] ${details.message} ` +
            `(${details.sourceId}:${details.lineNumber})`
        )
      }
    })
  }

  if (isDev()) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] as string)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // E2E 冒烟入口（DOC_E2E=<工作区目录> + DOC_E2E_PROBE=<探针模块绝对路径>）：只开一扇门，
  // 探针本体在本机 localscripts/e2e/probe.cjs（gitignored、不打进包），按绝对路径动态加载。
  // 开发（electron-vite dev）与预览（electron-vite preview，生产产物 + CSP）两种模式均可用。
  // 注意：动态 import 的路径来自环境变量，构建工具不会（也不该）尝试打包那个文件。
  if (process.env['DOC_E2E'] && process.env['DOC_E2E_PROBE']) {
    const probePath = process.env['DOC_E2E_PROBE']
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    mainWindow.webContents.on('did-finish-load', () => {
      void (async () => {
        try {
          // @vite-ignore：路径运行期才定（打包进 asar 后是 asar 外的一个绝对路径），
          // 让构建工具别解析、别尝试内联这个文件。
          const probe = (await import(/* @vite-ignore */ pathToFileURL(probePath).href)) as {
            runE2E: (ctx: {
              win: BrowserWindow
              log: (...args: unknown[]) => void
              sleep: (ms: number) => Promise<void>
            }) => Promise<void>
          }
          await probe.runE2E({ win: mainWindow as BrowserWindow, log: console.log, sleep })
        } catch (err) {
          console.error('[e2e] failed:', err)
        }
      })()
    })
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.AppGetInfo, () => ({
    version: app.getVersion(),
    platform: process.platform as 'win32' | 'darwin' | 'linux'
  }))

  ipcMain.on(IPC.WindowMinimize, () => {
    mainWindow?.minimize()
  })

  ipcMain.on(IPC.WindowToggleMaximize, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  })

  ipcMain.on(IPC.WindowClose, () => {
    lifecycle('渲染层请求关闭窗口')
    mainWindow?.close()
  })

  ipcMain.handle(IPC.WindowIsMaximized, () => mainWindow?.isMaximized() ?? false)
}

app.whenReady().then(() => {
  // 自绘标题栏：移除默认菜单（macOS 保留原生应用菜单占位，窗口内无菜单栏）
  Menu.setApplicationMenu(null)

  // 权限收敛：本应用不需要摄像头/麦克风/通知/定位等能力，一律拒绝
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    console.info('[security] 拒绝权限请求:', permission)
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  const { manager } = buildTemplateManager()
  projectService = new ProjectService(manager)
  registerProjectIpc(projectService)
  registerIpc()
  createMainWindow()

  // 退出前自动保存当前工程
  app.on('before-quit', () => {
    lifecycle('收到退出请求')
    projectService?.saveAndCloseProject()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  lifecycle('所有窗口已关闭，退出应用')
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
