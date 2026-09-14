import { app, BrowserWindow, ipcMain, Menu, nativeTheme, session, shell } from 'electron'
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
  mainWindow.on('closed', () => {
    mainWindow = null
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

  // E2E 诊断：转发渲染层「警告/错误」与 CSP 违规，使无头验收能观察到
  // "页面看似正常但被 CSP 拦截"的情况。
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

  // E2E 冒烟（DOC_E2E=<workspaceDir> 时执行）：DOM 驱动 新建工程→选中→编辑→保存
  // 开发（electron-vite dev）与预览（electron-vite preview，生产产物 + CSP）两种模式均可用
  if (process.env['DOC_E2E']) {
    const ws = process.env['DOC_E2E']
    mainWindow.webContents.on('did-finish-load', () => {
      const probe = `
        (async () => {
          const WS = ${JSON.stringify(ws)};
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const out = {};
          const waitFor = async (sel, ms = 6000) => {
            const t0 = Date.now();
            while (Date.now() - t0 < ms) {
              const el = document.querySelector(sel);
              if (el) return el;
              await sleep(80);
            }
            throw new Error('timeout: ' + sel);
          };
          const setNative = (el, val) => {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
          };
          await sleep(700);
          out.welcome = !!document.querySelector('.welcome');
          // 打开新建向导
          document.querySelector('.welcome-actions .btn-primary').click();
          await sleep(250);
          out.wizardOpen = !!document.querySelector('.wizard');
          const inputs = document.querySelectorAll('.wizard-config .w-field input');
          setNative(inputs[0], WS);
          setNative(inputs[1], 'e2e工程');
          await sleep(200);
          document.querySelector('.w-cards .w-card').click();
          await sleep(200);
          const createBtn = await waitFor('.wizard-foot .be-btn-primary:not(:disabled)');
          createBtn.click();
          // 等待编辑器出现
          await waitFor('.editor-workspace', 10000);
          await sleep(600);
          out.editor = !!document.querySelector('.editor-workspace');
          out.titlebarProject = (document.querySelector('.tb-center') || {}).textContent || null;
          out.treeRows = document.querySelectorAll('.tree-row').length + 1;
          // 选中根节点
          document.querySelector('.tree-root-row').click();
          await sleep(300);
          out.rootTitle = document.querySelector('.np-title') ? document.querySelector('.np-title').value : null;
          // 树搜索 '标识' 并选中
          const q = await waitFor('.tree-search input');
          setNative(q, '标识');
          await sleep(200);
          const rows = [...document.querySelectorAll('.tree-row')];
          const match = rows.find((r) => r.textContent.includes('标识'));
          if (match) match.click();
          await sleep(350);
          out.biaoShi = {
            title: document.querySelector('.np-title') ? document.querySelector('.np-title').value : null,
            blockCards: document.querySelectorAll('.block-card').length,
            chips: [...document.querySelectorAll('.np-chip')].map((c) => c.textContent.trim())
          };
          // 清空搜索恢复全树
          setNative(q, '');
          // 保存
          const saveBtn = await waitFor('.tb-action[aria-label="保存工程"]');
          saveBtn.click();
          await sleep(900);
          out.toast = document.querySelector('.toast') ? document.querySelector('.toast').textContent : null;
          // 导出 DOCX（真实对话框流程）
          const exportBtn = await waitFor('.tb-action[aria-label="导出 DOCX"]');
          exportBtn.click();
          await sleep(400);
          out.exportDialogOpen = ((document.querySelector('.wizard .wizard-head h2') || {}).textContent || '') === '导出文档';
          // 图表嵌入统计：必须反映文档里真实存在的块（图片与流程图分开计数）
          const figureSection = [...document.querySelectorAll('.settings-group')].find(
            (s) => ((s.querySelector('h3') || {}).textContent || '') === '图表嵌入'
          );
          out.exportFigureText = figureSection
            ? (figureSection.querySelector('p') || {}).textContent || null
            : null;
          const doExport = await waitFor('.wizard-foot .be-btn-primary');
          doExport.click();
          await sleep(1500);
          out.exportToast = document.querySelector('.toast') ? document.querySelector('.toast').textContent : null;
          // 预览视图切换
          const previewTab = [...document.querySelectorAll('.view-toggle button')].find((b) => b.textContent === '预览');
          if (previewTab) {
            previewTab.click();
            await sleep(900);
            out.previewPage = !!document.querySelector('.pv-article');
            out.previewListItems = document.querySelectorAll('.pv-list li').length;
            const editTab = [...document.querySelectorAll('.view-toggle button')].find((b) => b.textContent === '编辑');
            if (editTab) editTab.click();
            await sleep(300);
            out.backToEdit = !!document.querySelector('.np-blocks');
          }
          // 标题栏设置弹层：应能打开（壳层渲染）并可关闭
          const settingsBtn = await waitFor('.tb-btn[aria-label="设置"]');
          settingsBtn.click();
          await sleep(400);
          out.settingsOpen = ((document.querySelector('.settings-dialog .wizard-head h2') || {}).textContent || '') === '设置';
          const closeBtn = document.querySelector('.settings-dialog .wizard-head button');
          if (closeBtn) closeBtn.click();
          await sleep(350);
          out.settingsClosed = !document.querySelector('.settings-dialog');
          // 物理输入验证：返回保存按钮中心坐标，main 侧用 sendInputEvent 重放真实鼠标点击
          const physSave = document.querySelector('.tb-action[aria-label="保存工程"]');
          if (physSave) {
            const r = physSave.getBoundingClientRect();
            out.saveRect = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            out.saveToastBefore = (document.querySelector('.toast') || {}).textContent || null;
          }
          return out;
        })()
      `
      void mainWindow?.webContents
        .executeJavaScript(probe)
        .then(async (result) => {
          const data = result as Record<string, unknown>
          console.log('[e2e]', JSON.stringify(data))
          const rect = data['saveRect'] as { x: number; y: number } | undefined
          if (rect) {
            const win = mainWindow
            if (!win) return
            // 重放真实鼠标点击（经过 drag 命中测试）
            win.webContents.sendInputEvent({ type: 'mouseMove', x: rect.x, y: rect.y })
            win.webContents.sendInputEvent({ type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
            win.webContents.sendInputEvent({ type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 })
            await new Promise((resolve) => setTimeout(resolve, 1400))
            const toast = await win.webContents.executeJavaScript(
              `(document.querySelector('.toast') || {}).textContent || null`
            )
            console.log('[e2e-phys]', 'toast=', toast)
          }
        })
        .catch((err) => console.error('[e2e] failed:', err))
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
    projectService?.saveAndCloseProject()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
