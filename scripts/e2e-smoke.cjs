/**
 * e2e-smoke.cjs — 生产产物 E2E 冒烟：起真实 Electron，跑一遍打开工程到导出的主流程。
 *
 * 约定：**所有临时产物落在仓库 `temp/`**（gitignored），不写入系统临时目录。
 * 流程：构建后的渲染层产物 → electron-vite preview 启动 Electron →
 *       DOC_E2E 驱动 DOM 全流程（新建工程/编辑/保存/导出/预览/设置）→ 打印结果 JSON →
 *       再用 sendInputEvent 重放一次真实鼠标点击（[e2e-phys]），两段都验。
 *
 * 前置：本脚本**不构建**，跑之前必须有最新的 out/。用 `pnpm e2e`（含 pnpm build），
 *       直接 node 调用只适合刚构建完的场景。
 *
 * 用法（仓库根）：
 *   pnpm e2e                              # 构建 + 冒烟，跑完清理工作区
 *   node scripts/e2e-smoke.cjs --keep     # 保留 temp/e2e-<时间戳>/ 供检查
 *   node scripts/e2e-smoke.cjs --templates <dir>   # 覆盖模板目录（缺省合成夹具）
 *
 * 退出码：0 = E2E 通过；1 = 失败/超时。
 */
const { spawn, execSync } = require('node:child_process')
const { existsSync, mkdirSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const TEMP_ROOT = join(ROOT, 'temp')
const FIXTURE = join(ROOT, 'samples', 'sample-template')
const TIMEOUT_MS = 180_000
/** 关键断言通过后，等物理点击结果的时间上限 */
const PHYS_GRACE_MS = 15_000

function parseArgs(argv) {
  let keep = false
  let templates = FIXTURE
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keep') keep = true
    else if (argv[i] === '--templates' && argv[i + 1]) {
      templates = resolve(argv[i + 1])
      i++
    }
  }
  return { keep, templates }
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' })
    else process.kill(-pid, 'SIGKILL')
  } catch {
    /* 进程可能已退出 */
  }
}

/**
 * 检查探针产出的结果。
 * 以前只断言 editor/welcome/deleteOk 三项：导出失败、预览空白、设置打不开都会照样绿。
 */
function checkResult(data) {
  const problems = []
  const need = (ok, message) => {
    if (!ok) problems.push(message)
  }
  need(data.welcome === true, '欢迎页未出现')
  need(data.wizardOpen === true, '新建向导未打开')
  need(data.editor === true, '编辑器未出现')
  need(
    data.deleteOk === true,
    `删除内容块未生效：按钮=${data.deleteBtnFound} ` +
      `${data.demandCards} → ${data.blockCardsAfterDelete}，` +
      `提示=${data.deleteToast}`
  )
  // 内容块模板锁：界面有锁标记，keep / readonly 的删除与上下移置灰并写明原因，只读块的内容不可改
  need(data.keepLockTag === '锁定', `keep 档块没有锁标记：${data.keepLockTag}`)
  need(
    typeof data.keepLockTagTitle === 'string' && data.keepLockTagTitle.includes('模板规定'),
    `锁标记没写明模板的规定：${data.keepLockTagTitle}`
  )
  need(data.keepDeleteDisabled === true, 'keep 档块的删除按钮没有置灰')
  need(
    typeof data.keepDeleteTitle === 'string' && data.keepDeleteTitle.includes('不能删除'),
    `keep 档删除按钮的提示没写原因：${data.keepDeleteTitle}`
  )
  need(data.keepMoveDisabled === true, 'keep 档块的上下移按钮没有置灰')
  need(
    Array.isArray(data.keepMoveTitles) &&
      data.keepMoveTitles.length === 2 &&
      data.keepMoveTitles.every((t) => typeof t === 'string' && t.includes('不能移动')),
    `keep 档上下移按钮的提示没写原因：${JSON.stringify(data.keepMoveTitles)}`
  )
  need(
    data.lockedDeleteKept === true,
    `点置灰的删除按钮把块删掉了：${data.blockCardsAfterLockedDelete}`
  )
  need(data.storeLockValue === 'keep', `锁没有跟着块进工程数据：${data.storeLockValue}`)
  need(data.lockedTypeChangeRejected === true, '把锁定块改成别的类型没有被拒绝')
  need(
    typeof data.lockedTypeChangeError === 'string' && data.lockedTypeChangeError.includes('模板规定'),
    `拒绝改类型时没说明原因：${data.lockedTypeChangeError}`
  )
  need(
    JSON.stringify(data.lockedContentEditItems) === JSON.stringify(['条目一：示例改']),
    `锁定块的内容变更没有放行：${JSON.stringify(data.lockedContentEditItems)}，` +
      `错误=${data.lockedContentEditError}`
  )
  need(data.lockedContentRestored === true, '锁定块内容改回原值后没有读回原值')
  // 界面置灰之外，写入侧自己也要拒：keep 档删不掉也挪不动
  need(data.keepRemoveRejected === true, '写入侧没有拦住删除 keep 档块')
  need(
    typeof data.keepRemoveError === 'string' && data.keepRemoveError.includes('不能删除'),
    `拒绝删除时没说明原因：${data.keepRemoveError}`
  )
  need(data.keepMoveRejected === true, '写入侧没有拦住移动 keep 档块')
  need(
    typeof data.keepMoveError === 'string' && data.keepMoveError.includes('不能移动'),
    `拒绝移动时没说明原因：${data.keepMoveError}`
  )
  need(data.readonlyLockTag === '只读', `readonly 档块的标记不是「只读」：${data.readonlyLockTag}`)
  need(
    data.readonlyAreaReadOnly === true,
    `readonly 档块的文本输入没有只读：找到输入=${data.readonlyAreaFound}，readOnly=${data.readonlyAreaReadOnly}`
  )
  need(data.readonlyDeleteDisabled === true, 'readonly 档块的删除按钮没有置灰')
  need(
    typeof data.readonlyDeleteTitle === 'string' && data.readonlyDeleteTitle.includes('不能删除'),
    `readonly 档删除按钮的提示没写原因：${data.readonlyDeleteTitle}`
  )
  need(data.readonlyMoveDisabled === true, 'readonly 档块的上下移按钮没有置灰')
  need(
    Array.isArray(data.readonlyMoveTitles) &&
      data.readonlyMoveTitles.length === 2 &&
      data.readonlyMoveTitles.every((t) => typeof t === 'string' && t.includes('不能移动')),
    `readonly 档上下移按钮的提示没写原因：${JSON.stringify(data.readonlyMoveTitles)}`
  )
  // readonly 档的定稿内容：写入侧既不接受改内容，也不接受删除
  need(data.readonlyContentRejected === true, '写入侧没有拦住改 readonly 档块的内容')
  need(
    typeof data.readonlyContentError === 'string' && data.readonlyContentError.includes('内容不能改'),
    `拒绝改内容时没说明原因：${data.readonlyContentError}`
  )
  need(data.readonlyRemoveRejected === true, '写入侧没有拦住删除 readonly 档块')
  // 相邻档位：与 keep 块相邻的内容，上移按钮置灰并写清是相邻锁定挡住的
  need(data.neighborMoveUpDisabled === true, '与锁定块相邻的内容，上移按钮没有置灰')
  need(
    typeof data.neighborMoveUpTitle === 'string' && data.neighborMoveUpTitle.includes('相邻内容'),
    `相邻锁定导致的上移不可用没写原因：${data.neighborMoveUpTitle}`
  )
  need(
    typeof data.neighborCards === 'number' && data.neighborCardsAfterCleanup === data.neighborCards - 1,
    `验证相邻锁定时添加的内容没清理干净：${data.neighborCards} → ${data.neighborCardsAfterCleanup}`
  )
  // type 档只锁类型：删除与上下移照常可做，不能连删都锁上
  need(data.typeLockDeleteDisabled === false, 'type 档块的删除按钮被误置灰')
  need(data.typeLockMoveEnabled === true, 'type 档块的上下移按钮被误置灰')
  // 不锁的块不受影响：没有锁标记、删除按钮可用，且删除真的生效
  need(
    JSON.stringify(data.demandLockTags) === JSON.stringify(['锁定', null, null, null]),
    `多块章节里的锁标记不对：${JSON.stringify(data.demandLockTags)}`
  )
  need(data.unlockedLockTag === null, `没锁的块出现了锁标记：${data.unlockedLockTag}`)
  need(data.unlockedDeleteDisabled === false, '没锁的块删除按钮被置灰')
  need(data.exportDialogOpen === true, '导出对话框未打开')
  need(
    typeof data.exportToast === 'string' && data.exportToast.includes('导出') && !data.exportToast.includes('失败'),
    `导出结果提示异常：${data.exportToast}`
  )
  need(data.previewPage === true, '预览视图未渲染')
  need(data.backToEdit === true, '从预览切回编辑失败')
  // 整篇预览：多个章节节点、当前章节有标记、有问题时给检查摘要
  need(
    typeof data.previewNodes === 'number' && data.previewNodes > 1,
    `预览只渲染了一个章节：${data.previewNodes}`
  )
  need(data.previewCurrent === 1, `预览里当前章节标记异常：${data.previewCurrent}`)
  need(
    typeof data.previewPrecheck === 'string' && data.previewPrecheck.includes('导出前检查'),
    `预览缺少导出前检查摘要：${data.previewPrecheck}`
  )
  // 内容块折叠与标题入库
  need(
    typeof data.richBlockCards === 'number' && data.richBlockCards > 1,
    `多块章节的卡片数异常：${data.richBlockCards}`
  )
  need(data.collapsedCards === 1, `点折叠后收起态卡片数不对：${data.collapsedCards}`)
  need(data.collapsedBodyGone === true, '折叠后编辑器体仍然存在')
  need(data.collapsedAfterExpand === 0, `再点一次没有展开回来：${data.collapsedAfterExpand}`)
  need(data.titleSynced === true, '标题没有在停顿后自动入库（树上的标题没变）')
  need(data.settingsOpen === true, '设置弹层未打开')
  need(data.settingsClosed === true, '设置弹层未关闭')
  // 撤销与重做：改内容 → 撤销回退 → 重做恢复 → 再撤销还原
  need(data.histButtonsFound === true, '节点页没有找到撤销与重做按钮')
  need(data.histTextareaFound === true, '附录 A 章节里没有找到正文输入框')
  need(data.histRedoDisabledAtStart === true, '还没撤销过，重做按钮应当置灰')
  need(
    typeof data.histContentAfterEdit === 'string' && String(data.histContentAfterEdit).includes('撤销测试'),
    `在输入框里改字没有落库：${data.histContentAfterEdit}`
  )
  need(
    typeof data.histUndoLabel === 'string' && data.histUndoLabel.length > 0,
    `撤销按钮没有拿到动作名：${data.histUndoLabel}`
  )
  need(data.histUndoEnabledAfterEdit === true, '编辑之后撤销按钮没有解禁')
  need(data.histContentAfterUndo !== null && !String(data.histContentAfterUndo).includes('撤销测试'),
    `Ctrl+Z 没有把内容退回去：${data.histContentAfterUndo}`)
  need(data.histCanRedoAfterUndo === true, '撤销之后重做栈是空的')
  need(data.histRedoEnabledAfterUndo === true, '撤销之后重做按钮没有解禁')
  need(
    typeof data.histContentAfterRedo === 'string' && String(data.histContentAfterRedo).includes('撤销测试'),
    `Ctrl+Y 没有把内容改回来：${data.histContentAfterRedo}`
  )
  need(data.histContentRestored === true, '再撤销一次没有回到测试前的原文')
  need(data.histRedoClearedByNewEdit === true, '新编辑之后重做栈没有被清空')
  need(data.histCleanAfterTests === true, '撤销测试没有把文档清回原状')
  // 历史列表：面板能展开、条目录得出来、点一条能跳到那一步
  need(data.histCaretFound === true, '工具栏里没有找到历史列表按钮')
  need(data.histPanelOpen === true, '点了历史按钮没有展开面板')
  need(
    Array.isArray(data.histItems) && data.histItems.length > 0,
    `历史列表里没有条目：${JSON.stringify(data.histItems)}`
  )
  need(
    Array.isArray(data.histItems) && data.histItems.includes('修改内容'),
    `历史列表里没有内容编辑那一步：${JSON.stringify(data.histItems)}`
  )
  need(data.histRedoItemFound === true, '历史列表里没有可重做的那一条')
  need(
    typeof data.histContentAfterJump === 'string' && String(data.histContentAfterJump).includes('重做失效测试'),
    `点历史条目没有跳到那一步：${data.histContentAfterJump}`
  )
  need(data.histCleanAfterJump === true, '跳转之后没有撤销回原状')
  need(
    Array.isArray(data.themeOptions) && data.themeOptions.length === 3,
    `设置里应有主题三选项：${JSON.stringify(data.themeOptions)}`
  )
  need(data.themeSwitchOk === true, '设置里的主题切换未生效或未恢复原偏好')
  need(
    Array.isArray(data.settingsSections) && data.settingsSections.includes('主题'),
    `设置分区缺少主题：${JSON.stringify(data.settingsSections)}`
  )
  need(
    Array.isArray(data.settingsFootButtons) &&
      data.settingsFootButtons.includes('取消') &&
      data.settingsFootButtons.includes('保存设置'),
    `设置底部缺少取消/保存：${JSON.stringify(data.settingsFootButtons)}`
  )
  need(
    typeof data.settingsHintChars === 'number' && data.settingsHintChars < 160,
    `设置里的说明文字过长（${data.settingsHintChars} 字符），又回到大段注释了`
  )
  need(
    Array.isArray(data.tbActions) &&
      ['保存', '导出', '定位', '退出'].every((label) => data.tbActions.includes(label)),
    `标题栏工程操作组不齐：${JSON.stringify(data.tbActions)}`
  )
  need(typeof data.treeRows === 'number' && data.treeRows > 1, `树行数异常：${data.treeRows}`)
  // 标签语义：层级标题给素色数字，子标题给圆圈数字；章/节/条/子这套旧标签不许回来
  need(
    Array.isArray(data.treeBadges) &&
      ['1', '2', '3', '①'].every((badge) => data.treeBadges.includes(badge)),
    `节点标签不符合层级数字约定：${JSON.stringify(data.treeBadges)}`
  )
  need(
    Array.isArray(data.treeBadges) && !data.treeBadges.some((b) => ['章', '节', '条', '子'].includes(b)),
    `节点标签里还有旧的章/节/条/子：${JSON.stringify(data.treeBadges)}`
  )
  // 搜索：命中数、命中子串高亮、搜不到时的空状态
  need(
    typeof data.searchCount === 'string' && /^\d+\s*项$/.test(data.searchCount.trim()),
    `搜索命中数未显示：${data.searchCount}`
  )
  need(
    typeof data.searchHits === 'number' && data.searchHits > 0,
    `搜索命中子串没有高亮：${data.searchHits}`
  )
  need(
    typeof data.searchEmptyText === 'string' && data.searchEmptyText.includes('没有匹配'),
    `搜索无结果时缺少提示：${data.searchEmptyText}`
  )
  // 命中之间切换：搜索 附录 应有两处命中，下一个/上一个要能来回走并回绕
  need(data.hitButtons === true, '搜索框旁缺少上一个/下一个命中按钮')
  need(
    typeof data.hitCount === 'string' && data.hitCount.trim() === '2 项',
    `命中数不对：${data.hitCount}`
  )
  need(
    typeof data.hitFirst === 'string' && data.hitFirst.includes('附录'),
    `第一个命中不对：${data.hitFirst}`
  )
  need(
    typeof data.hitSecond === 'string' && data.hitSecond.includes('附录 A'),
    `下一个命中没走到第二处：${data.hitSecond}`
  )
  need(data.hitWrapped === data.hitFirst, `走到末尾没有回绕：${data.hitWrapped}`)
  need(data.hitPrev === data.hitSecond, `上一个命中不对：${data.hitPrev}`)
  // 树语义与键盘：容器要是 tree，方向键要能移动选中，且只有一行是选中态
  need(data.treeRole === 'tree', `树容器缺少 tree 语义：${data.treeRole}`)
  need(
    data.treeKeyMoved === true,
    `树里按方向键没有移动选中：${data.treeKeyBefore} → ${data.treeKeyAfter}`
  )
  need(data.treeAriaSelected === 1, `树里选中态行数异常：${data.treeAriaSelected}`)
  // 展开状态持久化（全折/全展的动作走「展开与折叠」菜单，菜单断言在下面）
  need(
    data.treeDeepRowsAfterCollapse === 0,
    `点全部折叠后二级以下仍有 ${data.treeDeepRowsAfterCollapse} 行`
  )
  need(
    typeof data.treeExpandState === 'string' && data.treeExpandState.trim() === '[]',
    `折叠状态没有写进工程库：${data.treeExpandState}`
  )
  need(
    typeof data.treeRowsAfterExpand === 'number' && data.treeRowsAfterExpand > 0,
    `点全部展开后没有恢复行：${data.treeRowsAfterExpand}`
  )
  // 按层级折叠：菜单项按文档实际深度生成，折到 2 级后更深的行必须消失，再全展要回来
  need(data.treeFoldMenuBtn === true, '结构栏缺少展开与折叠菜单')
  need(
    Array.isArray(data.treeFoldMenuItems) && data.treeFoldMenuItems.includes('折到 2 级'),
    `展开与折叠的菜单项不对：${JSON.stringify(data.treeFoldMenuItems)}`
  )
  need(data.treeHasDeepRowAtLevel2 === false, '折到 2 级后仍有更深层的行没被收起')
  need(
    typeof data.treeRowsAtLevel2 === 'number' && data.treeRowsAtLevel2 < data.treeRowsAfterExpand,
    `折到 2 级后行数没有减少：${data.treeRowsAtLevel2} 对 ${data.treeRowsAfterExpand}`
  )
  need(data.treeHasDeepRowAfterReset === true, '全展之后深层行没有回来')
  // 右键菜单
  need(data.menuOpen === true, '右键没有打开章节菜单')
  need(
    Array.isArray(data.menuItems) &&
      ['复制章节', '删除章节', '折叠该分支'].every((label) => data.menuItems.includes(label)),
    `章节菜单项不齐：${JSON.stringify(data.menuItems)}`
  )
  need(
    typeof data.menuHeadText === 'string' && data.menuHeadText.includes('范围'),
    `菜单头没有写清操作对象：${data.menuHeadText}`
  )
  need(data.menuSelectedTitle === '范围', `右键没有顺带选中该行：${data.menuSelectedTitle}`)
  need(
    Array.isArray(data.menuDisabledHints) &&
      data.menuDisabledHints.length > 0 &&
      data.menuDisabledHints.every((h) => typeof h === 'string' && h.length > 0),
    `菜单里禁用的项没写原因：${JSON.stringify(data.menuDisabledHints)}`
  )
  need(
    typeof data.menuFocus === 'string' && data.menuFocus.length > 0,
    `菜单打开后焦点没有落到可用项上：${data.menuFocus}`
  )
  need(data.menuClosed === true, 'Esc 没有关掉章节菜单')
  // 表格合并的补齐动作：按钮在、无可补时不改数据、有可补时确认后写跨度且内容不动。
  // 断言放在样例模板里唯一一张表上（表格在「引用文档」，需求章节没有表格块）。
  need(data.tableCompleteBtn === true, '表格编辑器缺少「补齐合并」按钮')
  need(
    typeof data.tableNoopHint === 'string' && data.tableNoopHint.includes('没有可补齐的合并'),
    `没有可补的合并时缺少提示：${data.tableNoopHint}`
  )
  need(
    data.tableSpanBefore === null && data.tableSpanAfterNoop === null,
    `没有可补的合并时 rowSpans 被动了：${JSON.stringify(data.tableSpanBefore)} → ` +
      `${JSON.stringify(data.tableSpanAfterNoop)}`
  )
  need(
    Array.isArray(data.tableCellValuesAfterNoop) &&
      JSON.stringify(data.tableCellValuesAfterNoop) === JSON.stringify(data.tableCellValuesBefore),
    `无补可补时单元格内容就变了：${JSON.stringify(data.tableCellValuesBefore)} → ` +
      `${JSON.stringify(data.tableCellValuesAfterNoop)}`
  )
  need(
    typeof data.tableConfirmText === 'string' && data.tableConfirmText.includes('将补齐 1 处合并'),
    `补齐前没有报出补几处：${data.tableConfirmText}`
  )
  need(data.tableConfirmBtn === true, '补齐确认里缺少确认按钮')
  need(
    JSON.stringify(data.tableSpansAfterComplete) === JSON.stringify({ 0: [[0, 2]] }),
    `确认补齐后 rowSpans 不对：${JSON.stringify(data.tableSpansAfterComplete)}`
  )
  need(
    data.tableCoveredCells === 1,
    `补齐后编辑区没有把第 2 行标成续格：${data.tableCoveredCells}`
  )
  need(
    Array.isArray(data.tableCellValuesAfterComplete) &&
      JSON.stringify(data.tableCellValuesAfterComplete) === JSON.stringify(data.tableCellValuesBeforeComplete),
    `补齐写跨度时改动了单元格内容：${JSON.stringify(data.tableCellValuesBeforeComplete)} → ` +
      `${JSON.stringify(data.tableCellValuesAfterComplete)}`
  )
  need(
    !(typeof data.tableToast === 'string' && data.tableToast.includes('失败')),
    `补齐合并不该报错：${data.tableToast}`
  )
  // 缩表后按新尺寸重算 rowSpans：缩列时界内的跨度留着，缩行时越界的跨度裁掉。
  // 缺陷现场：applySize 原样透传 rowSpans，缩表后旧跨度留在数据里，导出与预览的合并落到表外。
  need(
    typeof data.tableShrinkColConfirmText === 'string' &&
      data.tableShrinkColConfirmText.includes('会丢失'),
    `缩列前没有报出会丢内容：${data.tableShrinkColConfirmText}`
  )
  need(
    JSON.stringify(data.tableSpansAfterColShrink) === JSON.stringify({ 0: [[0, 2]] }),
    `缩列把仍在界内的跨度也动了：${JSON.stringify(data.tableSpansAfterColShrink)}`
  )
  need(
    data.tableCoveredCellsAfterColShrink === 1,
    `缩列后编辑区没把第 2 行标成续格：${data.tableCoveredCellsAfterColShrink}`
  )
  need(
    typeof data.tableShrinkRowConfirmText === 'string' &&
      data.tableShrinkRowConfirmText.includes('会丢失'),
    `缩行前没有报出会丢内容：${data.tableShrinkRowConfirmText}`
  )
  need(
    data.tableSpansAfterRowShrink === null,
    `缩行后越界的跨度没有被裁掉：${JSON.stringify(data.tableSpansAfterRowShrink)}`
  )
  need(
    data.tableCoveredCellsAfterRowShrink === 0,
    `缩行后编辑区还留着合并的续格：${data.tableCoveredCellsAfterRowShrink}`
  )
  need(
    JSON.stringify(data.tableSizeAfterShrink) === JSON.stringify(['1', '2']),
    `缩表后的尺寸不是新尺寸：${JSON.stringify(data.tableSizeAfterShrink)}`
  )
  need(
    JSON.stringify(data.tableCellValuesAfterRowShrink) === JSON.stringify(['1', null]),
    `缩表动了单元格内容：${JSON.stringify(data.tableCellValuesAfterRowShrink)}`
  )
  return problems
}

function main() {
  const { keep, templates } = parseArgs(process.argv.slice(2))
  const workspace = join(TEMP_ROOT, `e2e-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  console.log(`[e2e-smoke] 工作区：${workspace}`)
  console.log(`[e2e-smoke] 模板目录：${templates}`)

  const child = spawn('pnpm', ['--filter', '@documentor/desktop', 'start'], {
    cwd: ROOT,
    shell: true,
    env: {
      ...process.env,
      DOC_E2E: workspace,
      DOC_E2E_TEMPLATES: templates
    }
  })

  let settled = false
  let buffer = ''
  let resultData = null
  let physTimer = null
  /** 渲染层 CSP 违规：脚本被拦意味着功能静默失效，必须让冒烟红 */
  const cspViolations = []

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 结束：先杀进程树，等句柄释放后清理工作区（Windows 上立即删除常因句柄未释放失败） */
  const finish = async (code) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (physTimer) clearTimeout(physTimer)
    killTree(child.pid)
    await sleep(800)
    if (keep) {
      console.log(`[e2e-smoke] 已保留工作区：${workspace}`)
      process.exit(code)
    }
    let removed = false
    for (let attempt = 0; attempt < 5 && !removed; attempt++) {
      try {
        rmSync(workspace, { recursive: true, force: true })
      } catch {
        await sleep(500)
      }
      removed = !existsSync(workspace)
    }
    if (!removed) {
      console.warn(`[e2e-smoke] 注意：工作区未能清理，可能有残留进程占用句柄：${workspace}`)
    }
    process.exit(code)
  }

  const timer = setTimeout(() => {
    console.error(`[e2e-smoke] ✗ 超时（${TIMEOUT_MS / 1000}s）`)
    void finish(1)
  }, TIMEOUT_MS)

  // Ctrl+C / 被终止时也要收尾，否则会留下拿着工程数据库句柄的 Electron 进程
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.warn(`[e2e-smoke] 收到 ${sig}，清理后退出`)
      void finish(1)
    })
  }

  const onChunk = (chunk) => {
    const text = chunk.toString()
    process.stdout.write(text)
    buffer += text
    // 渲染层控制台告警/CSP 违规（主进程 E2E 钩子转发）
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('[renderer:')) continue
      const trimmed = line.trim()
      if (trimmed.includes('/csp')) {
        cspViolations.push(trimmed)
        console.error(`[e2e-smoke] ✗ CSP 违规：${trimmed}`)
      } else {
        console.warn(`[e2e-smoke] 注意：${trimmed}`)
      }
    }
    // 探针抛错时主进程只打印一行，早退比等到 180s 超时更能指出问题
    const failed = /\[e2e\] failed: (.*)/.exec(buffer)
    if (failed) {
      console.error(`[e2e-smoke] ✗ 界面探针执行失败：${failed[1].trim()}`)
      void finish(1)
      return
    }
    const m = buffer.match(/\[e2e\] (\{[\s\S]*?\})\s*\n/)
    if (m && resultData === null) {
      try {
        resultData = JSON.parse(m[1])
      } catch (err) {
        console.error('[e2e-smoke] ✗ 结果 JSON 解析失败：', err.message)
        void finish(1)
        return
      }
      const problems = checkResult(resultData)
      console.log(`[e2e-smoke] 探针结果：${JSON.stringify(resultData)}`)
      if (problems.length > 0) {
        for (const p of problems) console.error(`[e2e-smoke] ✗ ${p}`)
        console.error(`[e2e-smoke] ✗ 关键断言失败（${problems.length} 项）`)
        void finish(1)
        return
      }
      console.log('[e2e-smoke] 关键断言通过，等待物理点击验证…')
      physTimer = setTimeout(() => {
        console.error('[e2e-smoke] ✗ 未收到物理点击验证结果（[e2e-phys]）')
        void finish(1)
      }, PHYS_GRACE_MS)
      return
    }
    // 物理点击结果：主进程在探针之后重放真实鼠标点击，1.4s 后才打印
    const phys = /\[e2e-phys\] toast= (.*)/.exec(buffer)
    if (phys && resultData !== null && physTimer) {
      const keyLine = /\[e2e-keys\] (\{.*?\})\s*\n/.exec(buffer)
      if (!keyLine) return // 真实按键那一段还没打印，再等一会儿
      const undoLine = /\[e2e-undo\] (\{.*?\})\s*\n/.exec(buffer)
      if (!undoLine) return // 真实 Ctrl+Z 那一段还没打印
      clearTimeout(physTimer)
      physTimer = null
      const keys = JSON.parse(keyLine[1])
      const undo = JSON.parse(undoLine[1])
      const toast = phys[1].trim()
      const toastOk = toast.length > 0 && toast !== 'null' && !toast.includes('失败')
      const cspOk = cspViolations.length === 0
      const focusOk = typeof keys.focusClass === 'string' && keys.focusClass.includes('tree-scroll')
      const keyMoved = keys.selectedAfter !== null && keys.selectedAfter !== keys.selectedBefore
      // 真实 Ctrl+Z：改前与改后必须不同，退回来的必须与改前逐字相同
      const undoPrepared = undo.prepared
      const undoOk =
        undoPrepared !== null &&
        typeof undoPrepared === 'object' &&
        typeof undoPrepared.afterEdit === 'string' &&
        undoPrepared.afterEdit !== undoPrepared.before &&
        undoPrepared.canUndo === true &&
        undo.reverted === undoPrepared.before
      if (!toastOk) console.error(`[e2e-smoke] ✗ 物理点击保存未生效：toast=${toast}`)
      if (!cspOk) {
        console.error(`[e2e-smoke] ✗ 渲染层有 ${cspViolations.length} 条 CSP 违规，被拦的脚本不会执行`)
      }
      if (!focusOk) {
        console.error(`[e2e-smoke] ✗ 点树之后焦点没进树容器：${keys.focusClass}`)
      }
      if (!keyMoved) {
        console.error(
          `[e2e-smoke] ✗ 真实方向键没有移动选中：${keys.selectedBefore} → ${keys.selectedAfter}`
        )
      }
      if (!undoOk) {
        console.error(`[e2e-smoke] ✗ 真实 Ctrl+Z 没有退回改动前：${JSON.stringify(undo)}`)
      }
      const ok = toastOk && cspOk && focusOk && keyMoved && undoOk
      console.log(
        `[e2e-smoke] ${ok ? '✓ 全部通过' : '✗ 收尾断言失败'}：物理点击 toast=${toast}，` +
          `CSP 违规 ${cspViolations.length} 条，树焦点=${keys.focusClass}，` +
          `方向键 ${keys.selectedBefore} → ${keys.selectedAfter}，` +
          `真实 Ctrl+Z ${undoOk ? '已回退' : '未回退'}`
      )
      void finish(ok ? 0 : 1)
    }
  }

  child.stdout.on('data', onChunk)
  child.stderr.on('data', onChunk)
  child.on('exit', (code) => {
    if (!settled) {
      console.error(`[e2e-smoke] ✗ Electron 进程提前退出（code=${code}）`)
      void finish(1)
    }
  })
}

main()
