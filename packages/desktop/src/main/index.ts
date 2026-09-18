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
          // 层级标题用素色数字表示层级，子标题用带色圆圈数字表示本级次序
          out.treeBadges = [...document.querySelectorAll('.tree-scroll .tree-badge')].map((b) => b.textContent.trim());
          // 选中根节点
          document.querySelector('.tree-root-row').click();
          await sleep(300);
          out.rootTitle = document.querySelector('.np-title') ? document.querySelector('.np-title').value : null;
          // 树搜索 '标识' 并选中
          const q = await waitFor('.tree-search input');
          setNative(q, '标识');
          await sleep(200);
          out.searchCount = (document.querySelector('.tree-count') || {}).textContent || null;
          out.searchHits = document.querySelectorAll('.tree-hl').length;
          const rows = [...document.querySelectorAll('.tree-row')];
          const match = rows.find((r) => r.textContent.includes('标识'));
          if (match) match.click();
          await sleep(350);
          out.biaoShi = {
            title: document.querySelector('.np-title') ? document.querySelector('.np-title').value : null,
            blockCards: document.querySelectorAll('.block-card').length,
            chips: [...document.querySelectorAll('.np-chip')].map((c) => c.textContent.trim())
          };
          // 删除内容块：点第一张卡片的删除按钮，卡片数必须减一（且不弹错误提示）
          const cardsBefore = document.querySelectorAll('.block-card').length;
          const delBtn = document.querySelector('.block-card .block-card-actions .be-icon-btn.danger');
          out.deleteBtnFound = !!delBtn;
          if (delBtn && cardsBefore > 0) {
            delBtn.click();
            await sleep(700);
            out.blockCardsAfterDelete = document.querySelectorAll('.block-card').length;
            out.deleteToast = document.querySelector('.toast') ? document.querySelector('.toast').textContent : null;
            out.deleteOk = out.blockCardsAfterDelete === cardsBefore - 1;
          } else {
            out.blockCardsAfterDelete = cardsBefore;
            out.deleteOk = false;
          }
          // 清空搜索恢复全树
          setNative(q, '');
          await sleep(200);
          // 搜不到时要有话可说，不能只剩一个根行
          setNative(q, 'zzz-查无此章节');
          await sleep(250);
          out.searchEmptyText = document.querySelector('.tree-scroll .tree-empty') ? document.querySelector('.tree-scroll .tree-empty').textContent.trim() : null;
          out.searchCountEmpty = (document.querySelector('.tree-count') || {}).textContent || null;
          setNative(q, '');
          await sleep(200);
          // 命中之间切换：搜索框右侧的上一个/下一个命中
          setNative(q, '附录');
          await sleep(250);
          out.hitCount = (document.querySelector('.tree-count') || {}).textContent || null;
          const nextHit = document.querySelector('.tree-icon-btn[aria-label="下一个命中"]');
          const prevHit = document.querySelector('.tree-icon-btn[aria-label="上一个命中"]');
          out.hitButtons = !!nextHit && !!prevHit;
          const selectedTitle = () => (document.querySelector('.np-title') ? document.querySelector('.np-title').value : null);
          if (nextHit && prevHit) {
            nextHit.click();
            await sleep(300);
            out.hitFirst = selectedTitle();
            nextHit.click();
            await sleep(300);
            out.hitSecond = selectedTitle();
            nextHit.click();
            await sleep(300);
            out.hitWrapped = selectedTitle();
            prevHit.click();
            await sleep(300);
            out.hitPrev = selectedTitle();
          }
          setNative(q, '');
          await sleep(200);
          // 展开与折叠菜单：全折/全展/按层级折叠都从这里进
          const foldMenuBtn = document.querySelector('.tree-icon-btn[aria-label="展开与折叠"]');
          const openFoldMenu = async () => {
            foldMenuBtn.click();
            await sleep(220);
          };
          const clickFoldItem = async (label) => {
            const item = [...document.querySelectorAll('.tree-level-menu button')].find((b) => b.textContent.trim() === label);
            if (!item) return false;
            item.click();
            await sleep(250);
            return true;
          };
          out.treeFoldMenuBtn = !!foldMenuBtn;
          if (foldMenuBtn) {
            await openFoldMenu();
            out.treeFoldMenuItems = [...document.querySelectorAll('.tree-level-menu button')].map((b) => b.textContent.trim());
            await clickFoldItem('全部折叠');
            out.treeRowsAfterCollapse = document.querySelectorAll('.tree-row').length;
            // 折叠后顶层章节仍应可见，二级以下的行必须消失
            out.treeDeepRowsAfterCollapse = document.querySelectorAll('.tree-row[aria-level="3"], .tree-row[aria-level="4"]').length;
            out.treeExpandState = await window.documentor.uiState.load('tree_expanded');
            await openFoldMenu();
            await clickFoldItem('全部展开');
            out.treeRowsAfterExpand = document.querySelectorAll('.tree-row').length;
            // 按层级折叠：样例树最深四级，菜单里就有折到 2、3、4 级
            await openFoldMenu();
            await clickFoldItem('折到 2 级');
            out.treeRowsAtLevel2 = document.querySelectorAll('.tree-row').length;
            // 样例树里最深的一行是「附录 A」（在 3 级章节底下），折到 2 级后它必须消失
            out.treeHasDeepRowAtLevel2 = [...document.querySelectorAll('.tree-row')].some((r) => r.textContent.includes('附录 A'));
            await openFoldMenu();
            await clickFoldItem('全部展开');
            out.treeRowsAfterLevelReset = document.querySelectorAll('.tree-row').length;
            out.treeHasDeepRowAfterReset = [...document.querySelectorAll('.tree-row')].some((r) => r.textContent.includes('附录 A'));
          }
          // 右键菜单：右键顺带选中该行，菜单头写清对象，禁用项要说明原因，焦点落在可用项上
          const ctxRow = [...document.querySelectorAll('.tree-row')].find((r) => r.textContent.includes('范围'));
          if (ctxRow) {
            const rect = ctxRow.getBoundingClientRect();
            ctxRow.dispatchEvent(new MouseEvent('contextmenu', {
              bubbles: true,
              clientX: Math.round(rect.left + 20),
              clientY: Math.round(rect.top + 5)
            }));
            await sleep(300);
            out.menuOpen = !!document.querySelector('.tree-menu');
            out.menuItems = [...document.querySelectorAll('.tree-menu button')].map((b) => b.textContent.trim());
            out.menuHeadText = (document.querySelector('.tree-menu-head') || {}).textContent || null;
            out.menuDisabledHints = [...document.querySelectorAll('.tree-menu button:disabled')].map((b) => b.title);
            out.menuFocus = document.activeElement ? document.activeElement.textContent.trim() : null;
            out.menuSelectedTitle = document.querySelector('.np-title') ? document.querySelector('.np-title').value : null;
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            await sleep(200);
            out.menuClosed = !document.querySelector('.tree-menu');
            // 右键把选中挪到了这一行，验完把选中还回去，免得影响后面的断言（该章节不允许放内容块）
            const back = [...document.querySelectorAll('.tree-row')].find((r) => r.textContent.includes('标识'));
            if (back) {
              back.click();
              await sleep(300);
            }
          }
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
          // 图表与表格统计：必须反映文档里真实存在的块（图片 / mmd-visio / 表格分开计数）
          const sectionText = (title) => {
            const sec = [...document.querySelectorAll('.settings-group')].find(
              (s) => ((s.querySelector('h3') || {}).textContent || '') === title
            )
            return sec ? ((sec.querySelector('p') || {}).textContent || null) : null
          }
          out.exportFigureText = sectionText('图表嵌入')
          out.exportTableText = sectionText('表格')
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
          // 树键盘导航：聚焦树容器按方向键，选中项应当移动；放在最后做，免得影响前面的断言
          const treeScroll = document.querySelector('.tree-scroll');
          if (treeScroll) {
            out.treeRole = treeScroll.getAttribute('role');
            treeScroll.focus();
            const beforeKey = (document.querySelector('.tree-row.is-selected') || {}).textContent || null;
            treeScroll.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            await sleep(300);
            const afterKey = (document.querySelector('.tree-row.is-selected') || {}).textContent || null;
            out.treeKeyMoved = afterKey !== null && afterKey !== beforeKey;
            out.treeKeyBefore = beforeKey;
            out.treeKeyAfter = afterKey;
            out.treeAriaSelected = document.querySelectorAll('[role="treeitem"][aria-selected="true"]').length;
          }
          // 物理输入验证：返回保存按钮中心坐标，main 侧用 sendInputEvent 重放真实鼠标点击
          const physSave = document.querySelector('.tb-action[aria-label="保存工程"]');
          if (physSave) {
            const r = physSave.getBoundingClientRect();
            out.saveRect = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            out.saveToastBefore = (document.querySelector('.toast') || {}).textContent || null;
          }
          // 同样交给 main 侧重放真实点击 + 真实按键：合成事件会让"焦点没进来"这种问题假装通过
          const physRow = [...document.querySelectorAll('.tree-row')][1];
          if (physRow) {
            const r = physRow.getBoundingClientRect();
            out.treeKeyRowRect = { x: Math.round(r.left + 40), y: Math.round(r.top + r.height / 2) };
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
          // 真实鼠标点一行 → 真实方向键：验的就是"焦点有没有进树容器"这件事
          const rowRect = data['treeKeyRowRect'] as { x: number; y: number } | undefined
          const win = mainWindow
          if (rowRect && win) {
            win.webContents.sendInputEvent({ type: 'mouseMove', x: rowRect.x, y: rowRect.y })
            win.webContents.sendInputEvent({ type: 'mouseDown', x: rowRect.x, y: rowRect.y, button: 'left', clickCount: 1 })
            win.webContents.sendInputEvent({ type: 'mouseUp', x: rowRect.x, y: rowRect.y, button: 'left', clickCount: 1 })
            await new Promise((resolve) => setTimeout(resolve, 400))
            const focusClass = await win.webContents.executeJavaScript(
              `(document.activeElement && (document.activeElement.className || document.activeElement.tagName)) || null`
            )
            const selectedBefore = await win.webContents.executeJavaScript(
              `(document.querySelector('.tree-row.is-selected, .tree-root-row.is-selected') || {}).textContent || null`
            )
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
            await new Promise((resolve) => setTimeout(resolve, 400))
            const selectedAfter = await win.webContents.executeJavaScript(
              `(document.querySelector('.tree-row.is-selected, .tree-root-row.is-selected') || {}).textContent || null`
            )
            console.log(
              '[e2e-keys]',
              JSON.stringify({ focusClass, selectedBefore, selectedAfter })
            )
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
