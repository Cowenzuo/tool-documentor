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
          // 模板锁：卡片头上有锁标记，keep 档的删除按钮置灰且写明原因
          const cardAt = (i) => document.querySelectorAll('.block-card')[i] || null;
          const deleteBtnOf = (card) => card ? card.querySelector('.block-card-actions .be-icon-btn.danger') : null;
          const moveBtnsOf = (card) => card ? [...card.querySelectorAll('.block-card-actions .be-icon-btn')].slice(0, 2) : [];
          const lockTagOf = (card) => {
            const tag = card ? card.querySelector('.block-lock-tag') : null;
            return tag ? tag.textContent.trim() : null;
          };
          const findTreeNode = (n, title) => {
            if (!n) return null;
            if (n.title === title) return n;
            for (const c of n.children || []) {
              const hit = findTreeNode(c, title);
              if (hit) return hit;
            }
            return null;
          };
          const biaoShiNode = findTreeNode((await window.documentor.project.treeGetRoot()).root, '标识');
          const storeListBlock = biaoShiNode
            ? (biaoShiNode.contentBlocks || []).find((b) => b.type === 'orderedList')
            : null;
          out.storeLockValue = storeListBlock ? (storeListBlock.lock || null) : null;
          const keepCard = cardAt(0);
          const keepTag = keepCard ? keepCard.querySelector('.block-lock-tag') : null;
          out.keepLockTag = lockTagOf(keepCard);
          out.keepLockTagTitle = keepTag ? keepTag.title : null;
          const keepDel = deleteBtnOf(keepCard);
          out.keepDeleteDisabled = !!keepDel && keepDel.disabled === true;
          out.keepDeleteTitle = keepDel ? keepDel.title : null;
          const keepMoves = moveBtnsOf(keepCard);
          out.keepMoveDisabled = keepMoves.length === 2 && keepMoves.every((b) => b.disabled === true);
          out.keepMoveTitles = keepMoves.map((b) => b.title);
          // 置灰的删除按钮点下去不该有反应（禁用按钮不派发点击）
          const cardsBeforeLockedDelete = document.querySelectorAll('.block-card').length;
          if (keepDel) keepDel.click();
          await sleep(400);
          out.blockCardsAfterLockedDelete = document.querySelectorAll('.block-card').length;
          out.lockedDeleteKept = out.blockCardsAfterLockedDelete === cardsBeforeLockedDelete;
          // 相邻档位：与 keep 块相邻的内容，上移会把锁定的块挪走，按钮该置灰并写清原因
          const addEndBtn = document.querySelector('.np-add-btn');
          if (addEndBtn) {
            addEndBtn.click();
            await sleep(250);
            const textItem = [...document.querySelectorAll('.np-add-menu .np-add-label')].find(
              (el) => el.textContent.trim() === '文本'
            );
            const textBtn = textItem ? textItem.closest('button') : null;
            if (textBtn) {
              textBtn.click();
              await sleep(700);
              const cardsWithNeighbor = [...document.querySelectorAll('.block-card')];
              out.neighborCards = cardsWithNeighbor.length;
              const neighborCard = cardsWithNeighbor[cardsWithNeighbor.length - 1];
              const neighborUp = neighborCard ? moveBtnsOf(neighborCard)[0] : null;
              out.neighborMoveUpDisabled = !!neighborUp && neighborUp.disabled === true;
              out.neighborMoveUpTitle = neighborUp ? neighborUp.title : null;
              // 目标位置上有块时，keep 档的移动由写入侧拒绝（上一处删除检查同理）
              if (biaoShiNode) {
                try {
                  await window.documentor.block.move({ nodeId: biaoShiNode.id, from: 0, to: 1 });
                  out.keepMoveRejected = false;
                  out.keepMoveError = null;
                } catch (err) {
                  out.keepMoveRejected = true;
                  out.keepMoveError = err && err.message ? err.message : String(err);
                }
              }
              const neighborDel = neighborCard ? deleteBtnOf(neighborCard) : null;
              if (neighborDel) {
                neighborDel.click();
                await sleep(700);
              }
              out.neighborCardsAfterCleanup = document.querySelectorAll('.block-card').length;
            }
          }
          // 锁跟着块进工程数据；写入侧拒绝改类型，内容变更照常放行
          if (biaoShiNode && storeListBlock) {
            // 界面置灰只是提示，写入侧才是最后一道：keep 档的删除与移动都要拒
            try {
              await window.documentor.block.remove({ nodeId: biaoShiNode.id, index: 0 });
              out.keepRemoveRejected = false;
              out.keepRemoveError = null;
            } catch (err) {
              out.keepRemoveRejected = true;
              out.keepRemoveError = err && err.message ? err.message : String(err);
            }
            try {
              await window.documentor.block.update({
                nodeId: biaoShiNode.id,
                index: 0,
                block: { ...storeListBlock, type: 'text', content: '试图改成文本块' }
              });
              out.lockedTypeChangeRejected = false;
              out.lockedTypeChangeError = null;
            } catch (err) {
              out.lockedTypeChangeRejected = true;
              out.lockedTypeChangeError = err && err.message ? err.message : String(err);
            }
            try {
              await window.documentor.block.update({
                nodeId: biaoShiNode.id,
                index: 0,
                block: { ...storeListBlock, items: ['条目一：示例改'] }
              });
              const afterEdit = findTreeNode((await window.documentor.project.treeGetRoot()).root, '标识');
              out.lockedContentEditItems = afterEdit.contentBlocks[0].items;
              await window.documentor.block.update({
                nodeId: biaoShiNode.id,
                index: 0,
                block: storeListBlock
              });
              const afterRestore = findTreeNode((await window.documentor.project.treeGetRoot()).root, '标识');
              out.lockedContentRestored =
                JSON.stringify(afterRestore.contentBlocks[0].items) === JSON.stringify(storeListBlock.items);
            } catch (err) {
              out.lockedContentEditItems = null;
              out.lockedContentEditError = err && err.message ? err.message : String(err);
            }
          }
          // readonly 档：内容输入只读，锁标记写「只读」，删除与上下移同样置灰
          setNative(q, '');
          await sleep(250);
          const overviewRow = [...document.querySelectorAll('.tree-row')].find((r) => r.textContent.includes('概述'));
          if (overviewRow) {
            overviewRow.click();
            await sleep(450);
            const roCard = cardAt(0);
            out.readonlyLockTag = lockTagOf(roCard);
            const roTag = roCard ? roCard.querySelector('.block-lock-tag') : null;
            out.readonlyLockTagTitle = roTag ? roTag.title : null;
            const roArea = roCard ? roCard.querySelector('.block-card-body .be-textarea') : null;
            out.readonlyAreaFound = !!roArea;
            out.readonlyAreaReadOnly = roArea ? roArea.readOnly === true : null;
            const roDel = deleteBtnOf(roCard);
            out.readonlyDeleteDisabled = !!roDel && roDel.disabled === true;
            out.readonlyDeleteTitle = roDel ? roDel.title : null;
            const roMoves = moveBtnsOf(roCard);
            out.readonlyMoveDisabled = roMoves.length === 2 && roMoves.every((b) => b.disabled === true);
            out.readonlyMoveTitles = roMoves.map((b) => b.title);
            // readonly 档：内容由模板给定，写入侧的改内容与删除都要拒
            const gaiShuNode = findTreeNode((await window.documentor.project.treeGetRoot()).root, '概述');
            const roStoreBlock = gaiShuNode ? (gaiShuNode.contentBlocks || [])[0] : null;
            if (gaiShuNode && roStoreBlock && roStoreBlock.lock === 'readonly') {
              try {
                await window.documentor.block.update({
                  nodeId: gaiShuNode.id,
                  index: 0,
                  block: { ...roStoreBlock, content: '试图改定稿' }
                });
                out.readonlyContentRejected = false;
                out.readonlyContentError = null;
              } catch (err) {
                out.readonlyContentRejected = true;
                out.readonlyContentError = err && err.message ? err.message : String(err);
              }
              try {
                await window.documentor.block.remove({ nodeId: gaiShuNode.id, index: 0 });
                out.readonlyRemoveRejected = false;
                out.readonlyRemoveError = null;
              } catch (err) {
                out.readonlyRemoveRejected = true;
                out.readonlyRemoveError = err && err.message ? err.message : String(err);
              }
            }
          }
          // type 档只锁类型：删除与上下移照常；不锁的块一切照旧，删除要真的生效
          const demandRow = [...document.querySelectorAll('.tree-row')].find((r) => r.textContent.includes('需求'));
          if (demandRow) {
            demandRow.click();
            await sleep(450);
            const demandCards = [...document.querySelectorAll('.block-card')];
            out.demandCards = demandCards.length;
            out.demandLockTags = demandCards.map((c) => lockTagOf(c));
            const typeDel = deleteBtnOf(demandCards[0]);
            const typeMoves = moveBtnsOf(demandCards[0]);
            out.typeLockDeleteDisabled = !!typeDel && typeDel.disabled === true;
            out.typeLockMoveEnabled = typeMoves.length === 2 && typeMoves.some((b) => b.disabled === false);
            const unlockedCard = demandCards[demandCards.length - 1];
            out.unlockedLockTag = lockTagOf(unlockedCard);
            const unlockedDel = deleteBtnOf(unlockedCard);
            out.unlockedDeleteDisabled = !!unlockedDel && unlockedDel.disabled === true;
            out.deleteBtnFound = !!unlockedDel;
            if (unlockedDel && demandCards.length > 0) {
              unlockedDel.click();
              await sleep(800);
              out.blockCardsAfterDelete = document.querySelectorAll('.block-card').length;
              out.deleteToast = document.querySelector('.toast') ? document.querySelector('.toast').textContent : null;
              out.deleteOk = out.blockCardsAfterDelete === demandCards.length - 1;
            } else {
              out.blockCardsAfterDelete = demandCards.length;
              out.deleteOk = false;
            }
          }
          // 标题栏工程操作组：保存、导出、定位、退出四个按钮都应在
          out.tbActions = [...document.querySelectorAll('.tb-right .tb-action')].map((b) => b.textContent.trim());
          // 块折叠：切到内容多的章节，收起第一张卡片后正文应当消失，再展开回来
          // 先清空搜索，否则树上被过滤得只剩命中项，找不到目标章节
          setNative(q, '');
          await sleep(250);
          const richRow = [...document.querySelectorAll('.tree-row')].find((r) => r.textContent.includes('需求'));
          if (richRow) {
            richRow.click();
            await sleep(400);
            out.richBlockCards = document.querySelectorAll('.block-card').length;
            const foldBtn = document.querySelector('.block-card .block-card-collapse');
            if (foldBtn) {
              foldBtn.click();
              await sleep(200);
              out.collapsedCards = document.querySelectorAll('.block-card.is-collapsed').length;
              out.collapsedBodyGone = !document.querySelector('.block-card.is-collapsed .block-card-body');
              out.collapsedSummary = (document.querySelector('.block-card-summary') || {}).textContent || null;
              const again = document.querySelector('.block-card .block-card-collapse');
              if (again) again.click();
              await sleep(200);
              out.collapsedAfterExpand = document.querySelectorAll('.block-card.is-collapsed').length;
            }
            // 标题不等失焦就入库：改完标题停顿一下，树上的标题应当跟着变
            const titleInput = document.querySelector('.np-title');
            if (titleInput) {
              setNative(titleInput, '需求改');
              // 标题是防抖入库：轮询等树上的行真的变了，别拿固定等待赌时间
              const titleDeadline = Date.now() + 4000;
              out.titleSynced = false;
              while (Date.now() < titleDeadline) {
                await sleep(200);
                if ([...document.querySelectorAll('.tree-row')].some((r) => r.textContent.includes('需求改'))) {
                  out.titleSynced = true;
                  break;
                }
              }
            }
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
          // 表格合并的补齐动作：样例模板里表格在「引用文档」，需求章节没有表格块，
          // 所以这一段按表格所在章节驱动。分两次点：
          // 第一次这张表两行内容不同，没有可补的合并，只提示、不改数据；
          // 第二次先把同列相邻两格改成同值，补齐应当报出 1 处并在确认后写出 rowSpans。
          const tableRow = [...document.querySelectorAll('.tree-row')].find((r) => r.textContent.includes('引用文档'));
          if (tableRow) {
            tableRow.click();
            await sleep(400);
            out.tableChapterCards = document.querySelectorAll('.block-card').length;
            const tableCell = (r, c) => document.querySelector('.be-table-cell[data-cell="' + r + ':' + c + '"]');
            const cellText = (r, c) => { const el = tableCell(r, c); return el ? el.value : null; };
            const values = () => [cellText(0, 0), cellText(1, 0)];
            const readSpans = async () => {
              const res = await window.documentor.project.treeGetRoot();
              const walk = (n) => {
                if (!n) return null;
                if (n.title === '引用文档') return n;
                for (const child of n.children || []) {
                  const hit = walk(child);
                  if (hit) return hit;
                }
                return null;
              };
              const node = walk(res.root);
              const tbl = ((node && node.contentBlocks) || []).find((b) => b.type === 'table');
              return tbl ? (tbl.rowSpans || null) : null;
            };
            const completeBtn = document.querySelector('.be-table-merge-complete');
            out.tableCompleteBtn = !!completeBtn;
            out.tableSpanBefore = await readSpans();
            out.tableCellValuesBefore = values();
            if (completeBtn) {
              completeBtn.click();
              await sleep(350);
              out.tableNoopHint = (document.querySelector('.be-table-complete-hint') || {}).textContent || null;
              out.tableSpanAfterNoop = await readSpans();
              out.tableCellValuesAfterNoop = values();
              // 制造一处可补的合并：把第二行第一格改成与上一行同值
              setNative(tableCell(1, 0), '1');
              await sleep(350);
              out.tableCellValuesBeforeComplete = values();
              completeBtn.click();
              await sleep(350);
              const confirmBox = document.querySelector('.be-table-confirm[aria-label="确认补齐合并"]');
              out.tableConfirmText = confirmBox ? confirmBox.textContent : null;
              const confirmBtn = document.querySelector('.be-table-complete-confirm');
              out.tableConfirmBtn = !!confirmBtn;
              if (confirmBtn) {
                confirmBtn.click();
                await sleep(700);
                out.tableSpansAfterComplete = await readSpans();
                out.tableCellValuesAfterComplete = values();
                out.tableCoveredCells = document.querySelectorAll('.be-table-cell-merged').length;
                out.tableToast = document.querySelector('.toast') ? document.querySelector('.toast').textContent : null;
              }
              // 缩表后跨度必须按新尺寸重算（只动跨度、不动 data）：
              // 先缩列（3 → 2），第 0 列的跨度仍在界内，应当原样留着；
              // 再缩行（2 → 1），跨两行的跨度整段落到表外，应当被裁掉。
              // 旧实现把 rowSpans 原样透传，缩表后越界的跨度留在数据里，导出与预览的合并落到表外。
              const sizeInput = (i) => document.querySelectorAll('.be-table-size input')[i];
              const shrinkTo = async (i, value) => {
                const input = sizeInput(i);
                if (!input) return null;
                setNative(input, String(value));
                await sleep(350);
                const box = document.querySelector('.be-table-confirm[aria-label="确认缩减表格"]');
                const text = box ? box.textContent : null;
                const btn = box ? box.querySelector('.be-btn.danger-text') : null;
                if (btn) {
                  btn.click();
                  await sleep(700);
                }
                return text;
              };
              out.tableShrinkColConfirmText = await shrinkTo(1, 2);
              out.tableSpansAfterColShrink = await readSpans();
              out.tableCoveredCellsAfterColShrink = document.querySelectorAll('.be-table-cell-merged').length;
              out.tableShrinkRowConfirmText = await shrinkTo(0, 1);
              out.tableSpansAfterRowShrink = await readSpans();
              out.tableCoveredCellsAfterRowShrink = document.querySelectorAll('.be-table-cell-merged').length;
              out.tableSizeAfterShrink = [
                sizeInput(0) ? sizeInput(0).value : null,
                sizeInput(1) ? sizeInput(1).value : null
              ];
              out.tableCellValuesAfterRowShrink = values();
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
            // 整篇预览：章节节点数应当多于一个，当前章节要标出来；有问题时顶部给检查摘要
            out.previewNodes = document.querySelectorAll('.pv-node').length;
            out.previewCurrent = document.querySelectorAll('.pv-node.is-current').length;
            out.previewPrecheck = (document.querySelector('.pv-precheck') || {}).textContent || null;
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
          out.settingsSections = [...document.querySelectorAll('.settings-dialog .settings-group h3')].map((h) => h.textContent);
          out.settingsFootButtons = [...document.querySelectorAll('.settings-dialog .wizard-foot button')].map((b) => b.textContent.trim());
          // 说明文字只留短句：长段散文会在这里露馅（阈值取 160 字符，正常反馈远低于它）
          out.settingsHintChars = [...document.querySelectorAll('.settings-dialog .settings-status, .settings-dialog .settings-hint')].reduce((n, el) => n + (el.textContent || '').trim().length, 0);
          // 主题收在设置里：三选一，切换要真的落到 data-theme 上，验完恢复原偏好
          const themeButtons = [...document.querySelectorAll('.settings-seg button')];
          out.themeOptions = themeButtons.map((b) => b.textContent);
          const themeBefore = localStorage.getItem('doc-theme') || 'system';
          const darkBtn = themeButtons.find((b) => b.textContent === '深色');
          const backBtn = themeButtons.find((b) => b.textContent === (themeBefore === 'dark' ? '深色' : themeBefore === 'light' ? '浅色' : '跟随系统'));
          if (darkBtn && backBtn) {
            darkBtn.click();
            await sleep(250);
            const switched = document.documentElement.dataset.theme === 'dark';
            backBtn.click();
            await sleep(250);
            const restored = (localStorage.getItem('doc-theme') || 'system') === themeBefore;
            out.themeSwitchOk = switched && restored;
          } else {
            out.themeSwitchOk = false;
          }
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
          // 撤销与重做：改一段正文 → 撤销回退 → 重做恢复 → 再撤销还原，最后用按钮状态收尾
          const histBtn = (label) =>
            [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === label) || null;
          const pressKey = (key, shift) => {
            window.dispatchEvent(
              new KeyboardEvent('keydown', { key, ctrlKey: true, shiftKey: !!shift, bubbles: true, cancelable: true })
            );
          };
          // 本章在"标题同步"那一步被改成"需求改"，两个名字都认，免得依赖执行顺序
          const appendixOf = async () => {
            const root = (await window.documentor.project.treeGetRoot()).root;
            return findTreeNode(root, '附录 A') || findTreeNode(root, '附录A');
          };
          // 撤销测试挑"附录 A"：那里有一段正文块，标题也不会被前面的步骤改掉
          const appendixRow = [...document.querySelectorAll('.tree-row')].find((r) =>
            r.textContent.includes('附录 A')
          );
          if (appendixRow) {
            appendixRow.click();
            await sleep(450);
            const appendixNode = await appendixOf();
            const textIndex = appendixNode
              ? (appendixNode.contentBlocks || []).findIndex((b) => b.type === 'text')
              : -1;
            if (appendixNode && textIndex >= 0) {
              const original = appendixNode.contentBlocks[textIndex].content;
              const undoBtn = histBtn('撤销');
              const redoBtn = histBtn('重做');
              out.histButtonsFound = !!undoBtn && !!redoBtn;
              out.histRedoDisabledAtStart = redoBtn ? redoBtn.disabled === true : null;
              // 在真实输入框里改字：这条路径才会走防抖提交与界面自己的历史状态刷新，
              // 直接用 block.update 会绕过刷新，按钮与快捷键的状态就不是用户看到的那样
              const textArea = document.querySelector('.block-card.type-text .be-textarea');
              out.histTextareaFound = !!textArea;
              if (textArea) {
                setNative(textArea, original + '（撤销测试）');
                await sleep(1200);
              }
              const editedNode = await appendixOf();
              out.histContentAfterEdit = editedNode ? editedNode.contentBlocks[textIndex].content : null;
              out.histUndoLabel = (await window.documentor.history.state()).undoLabel;
              out.histUndoEnabledAfterEdit = undoBtn ? undoBtn.disabled === false : null;
              // 快捷键走的是应用级撤销：文本框里按 Ctrl+Z 也进这条路
              pressKey('z', false);
              await sleep(800);
              const afterUndoNode = await appendixOf();
              out.histContentAfterUndo = afterUndoNode ? afterUndoNode.contentBlocks[textIndex].content : null;
              const undoState = await window.documentor.history.state();
              out.histCanRedoAfterUndo = undoState.canRedo;
              out.histRedoEnabledAfterUndo = redoBtn ? redoBtn.disabled === false : null;
              // 重做恢复改动
              pressKey('y', false);
              await sleep(800);
              const afterRedoNode = await appendixOf();
              out.histContentAfterRedo = afterRedoNode ? afterRedoNode.contentBlocks[textIndex].content : null;
              // 再撤销回原状：文档回到测试前的样子
              pressKey('z', false);
              await sleep(800);
              const restoredNode = await appendixOf();
              out.histContentRestored = restoredNode
                ? restoredNode.contentBlocks[textIndex].content === original
                : null;
              // 新编辑清空重做栈：同样走输入框
              const textAreaAgain = document.querySelector('.block-card.type-text .be-textarea');
              if (textAreaAgain) {
                setNative(textAreaAgain, original + '（重做失效测试）');
                await sleep(1200);
              }
              out.histRedoClearedByNewEdit = (await window.documentor.history.state()).canRedo === false;
              // 清干净：把这一步撤销掉，文档回到原状
              pressKey('z', false);
              await sleep(800);
              const cleanNode = await appendixOf();
              out.histCleanAfterTests = cleanNode
                ? cleanNode.contentBlocks[textIndex].content === original
                : null;
              // 历史列表：展开面板、读出条目、点"下一次重做"那一条跳过去
              const caret = document.querySelector('.hist-caret');
              out.histCaretFound = !!caret;
              if (caret) {
                caret.click();
                await sleep(300);
                const panel = document.querySelector('.hist-panel');
                out.histPanelOpen = !!panel;
                out.histItems = panel
                  ? [...panel.querySelectorAll('.hist-item')].map((el) => el.textContent.trim())
                  : null;
                const listed = await window.documentor.history.state();
                const nextKeep = listed.undoLabels.length + 1;
                const nextRedoItem = panel
                  ? panel.querySelector('.hist-item[data-keep="' + nextKeep + '"]')
                  : null;
                out.histRedoItemFound = !!nextRedoItem;
                if (nextRedoItem) {
                  nextRedoItem.click();
                  await sleep(800);
                }
                const jumpedNode = await appendixOf();
                out.histContentAfterJump = jumpedNode
                  ? jumpedNode.contentBlocks[textIndex].content
                  : null;
                // 清干净：把跳过来的这一步再撤销掉
                pressKey('z', false);
                await sleep(800);
                const finalNode = await appendixOf();
                out.histCleanAfterJump = finalNode
                  ? finalNode.contentBlocks[textIndex].content === original
                  : null;
              }
            }
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
          // 真实 Ctrl+Z：先经渲染层改一段正文，再发真实按键，看文字是否退回改前
          if (win) {
            const finder = `const find = (n, t) => { if (!n) return null; if (n.title === t) return n; for (const c of n.children || []) { const h = find(c, t); if (h) return h; } return null; };`;
            const prepared = await win.webContents.executeJavaScript(`(async () => {
              ${finder}
              const root = (await window.documentor.project.treeGetRoot()).root;
              const node = find(root, '附录 A') || find(root, '附录A');
              const i = node ? node.contentBlocks.findIndex((b) => b.type === 'text') : -1;
              if (!node || i < 0) return null;
              const before = node.contentBlocks[i].content;
              await window.documentor.block.update({
                nodeId: node.id,
                index: i,
                block: { ...node.contentBlocks[i], content: before + '（真实按键撤销）' }
              });
              const after = (await window.documentor.project.treeGetRoot()).root;
              const node2 = find(after, '附录 A') || find(after, '附录A');
              return { before, afterEdit: node2.contentBlocks[i].content, canUndo: (await window.documentor.history.state()).canUndo };
            })()`)
            await new Promise((resolve) => setTimeout(resolve, 300))
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Z', modifiers: ['control'] })
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Z', modifiers: ['control'] })
            await new Promise((resolve) => setTimeout(resolve, 800))
            const reverted = await win.webContents.executeJavaScript(`(async () => {
              ${finder}
              const root = (await window.documentor.project.treeGetRoot()).root;
              const node = find(root, '附录 A') || find(root, '附录A');
              const i = node ? node.contentBlocks.findIndex((b) => b.type === 'text') : -1;
              return node && i >= 0 ? node.contentBlocks[i].content : null;
            })()`)
            console.log('[e2e-undo]', JSON.stringify({ prepared, reverted }))
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
