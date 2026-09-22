/**
 * 模板编辑页（PLAN-11 批次 2）：整页独立，不打开工程、不进撤销栈、不挂编辑器的组件树。
 * 三栏：左栏模板列表（目录与模板、问题徽标），中栏节点树，右栏选中节点的表单。
 * 改动只落在内存草稿里，写文件只发生在页脚那个「保存」按钮。
 *
 * 最下面那条页脚是这一页唯一的状态栏，**固定一行高**：里面的东西再长也不许把它撑起来，
 * 否则三栏跟着缩一截，看着像页面在抖。这条上的消息分三类：
 *   ① 要你先点一下的确认（未保存改动）——文字与两个按钮都摆在这一行上；
 *   ② 一次操作的回执（保存/新建/删除/改名，失败带原因）——一行摘要，
 *      备份位置、报错原文这类长内容点「详情」弹浮层；
 *   ③ 校验小结（几个错误、几处提示）——点开是"问题在哪"的索引（浮层里按位置归堆、
 *      可点着跳过去）；逐条原话只在节点详情视图里说，状态栏不重复一遍。
 *
 * 三栏可拖：左与中记宽度（本机 localStorage，口径同主编辑器的结构栏），右栏吃掉剩下的。
 * 窗口变窄时按比例收左与中，先保右栏的最小可用宽度——要填的字都在右栏。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useApp } from '../state/AppContext'
import NodeForm from '../components/template/NodeForm'
import NodeTree from '../components/template/NodeTree'
import StyleTable from '../components/template/StyleTable'
import TemplateList from '../components/template/TemplateList'
import { RefreshIcon } from '../components/template/icons'
import { CloseIcon } from '../components/icons'
import {
  countBlocks,
  countNodes,
  groupIssuesByLocation,
  nodeJsonPath,
  type IssueGroup,
  type NodePath
} from '../components/template/templateDoc'
import { groupStyleIssues } from '../components/template/templateStyleDoc'
import { countIssues, issuesUnder } from '../components/template/templateValidate'
import { useTemplateEditor } from '../components/template/useTemplateEditor'
import '../components/template/template.css'

/** 分隔条宽度（px），与 template.css 的 .tpl-split 一致 */
const HANDLE = 5
const LIST_MIN = 168
const LIST_MAX = 420
const TREE_MIN = 200
const TREE_MAX = 560
/** 右栏最小可用宽度：窗口不够时先收左与中，不动它 */
const INSP_MIN = 380
const LIST_WIDTH_KEY = 'layout.templateListWidth'
const TREE_WIDTH_KEY = 'layout.templateTreeWidth'

function readWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const saved = Number.parseInt(localStorage.getItem(key) ?? '', 10)
    if (Number.isFinite(saved)) return Math.min(max, Math.max(min, saved))
  } catch {
    /* 忽略：读不到就用默认值 */
  }
  return fallback
}

export default function TemplateEditorPage(): JSX.Element {
  const { closeTemplateEditor } = useApp()
  const editor = useTemplateEditor()
  const counts = countIssues(editor.issues)
  const open = editor.doc !== null
  const styleOpen = editor.openKind === 'style'
  /** 校验小结点开后那份"问题在哪"的索引：按位置归堆，逐条原话在节点详情里 */
  const structureIssueGroups: IssueGroup[] = useMemo(
    () => (styleOpen ? [] : groupIssuesByLocation(editor.doc, editor.issues)),
    [editor.doc, editor.issues, styleOpen]
  )
  /** 样式侧的同一份索引：位置是字段名（映射 heading.1 这类），没有可跳的节点 */
  const styleIssueGroups: IssueGroup[] = useMemo(
    () => (styleOpen ? groupStyleIssues(editor.issues) : []),
    [editor.issues, styleOpen]
  )
  const issueGroups = styleOpen ? styleIssueGroups : structureIssueGroups

  // ---------- 三栏宽度 ----------
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const [avail, setAvail] = useState(0)
  const [listWidth, setListWidth] = useState(() => readWidth(LIST_WIDTH_KEY, 244, LIST_MIN, LIST_MAX))
  const [treeWidth, setTreeWidth] = useState(() => readWidth(TREE_WIDTH_KEY, 292, TREE_MIN, TREE_MAX))

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const measure = (): void => setAvail(Math.round(el.getBoundingClientRect().width))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /**
   * 真正渲染出去的宽度：窗口不够时按比例收左与中，右栏保底 INSP_MIN。
   * 拖拽与键盘都以这两个值为起点，所以窄窗口里第一次调不会跳。
   */
  const layout = useMemo(() => {
    let list = listWidth
    let tree = treeWidth
    const room = avail - HANDLE * 2 - INSP_MIN
    if (avail > 0 && list + tree > room) {
      const scale = Math.max(0, room) / (list + tree)
      list = Math.max(LIST_MIN, Math.round(list * scale))
      tree = Math.max(TREE_MIN, Math.round(tree * scale))
    }
    return { list, tree }
  }, [avail, listWidth, treeWidth])
  const layoutRef = useRef(layout)
  useEffect(() => {
    layoutRef.current = layout
  }, [layout])

  /** 落一个宽度：写进 state（界面）并记到本机（下次打开还是这个宽度） */
  const commitWidth = useCallback((which: 'list' | 'tree', value: number): void => {
    const min = which === 'list' ? LIST_MIN : TREE_MIN
    const max = which === 'list' ? LIST_MAX : TREE_MAX
    const next = Math.round(Math.min(max, Math.max(min, value)))
    if (which === 'list') setListWidth(next)
    else setTreeWidth(next)
    try {
      localStorage.setItem(which === 'list' ? LIST_WIDTH_KEY : TREE_WIDTH_KEY, String(next))
    } catch {
      /* 忽略：写不进去也不影响本次使用 */
    }
  }, [])

  const startDrag = useCallback(
    (which: 'list' | 'tree', event: React.MouseEvent): void => {
      event.preventDefault()
      const startX = event.clientX
      const from = which === 'list' ? layoutRef.current.list : layoutRef.current.tree
      // 另一栏与右栏的最小宽度决定了这一栏最多能拖到哪
      const other = which === 'list' ? layoutRef.current.tree : layoutRef.current.list
      const base = which === 'list' ? LIST_MIN : TREE_MIN
      const max = Math.max(
        base,
        (avail > 0 ? avail : Number.MAX_SAFE_INTEGER) - HANDLE * 2 - INSP_MIN - other
      )

      document.body.classList.add('is-splitting')
      const onMove = (ev: MouseEvent): void => {
        commitWidth(which, Math.min(max, from + (ev.clientX - startX)))
      }
      const onUp = (): void => {
        document.body.classList.remove('is-splitting')
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [avail, commitWidth]
  )

  /** 分隔条也能用键盘推：左右方向键各 16px */
  const nudge = useCallback(
    (which: 'list' | 'tree', delta: number): void => {
      const from = which === 'list' ? layoutRef.current.list : layoutRef.current.tree
      commitWidth(which, from + delta)
    },
    [commitWidth]
  )

  const nodeIssues = editor.selectedNode
    ? issuesUnder(editor.issues, nodeJsonPath(editor.selectedPath))    : []

  /**
   * 保存按钮为什么不能按：一句话说清，按钮与那盏灯的悬停提示都用它。
   * （顶栏只放最短的「N 个错误 / 未保存」，完整理由在提示里，状态栏里有索引可跳。）
   */
  const saveWhy = !styleOpen && !open
    ? '未打开模板'
    : counts.errors > 0
      ? `${counts.errors} 个错误 · 先修复`
      : !editor.dirty
        ? '与文件一致'
        : editor.busy
          ? '正在处理…'
          : ''
  const canSave = (open || styleOpen) && editor.dirty && counts.errors === 0 && !editor.busy

  /**
   * 右端那盏灯与它的短句：红=有错误（挡住保存）、琥珀=有未保存的改动、绿=与文件一致。
   * 文字只留最短的（「3 个错误」「未保存」），完整理由进悬停提示——
   * 顶栏不是写解释的地方，要看的细节在状态栏与问题索引里。
   */
  const draftState = (!open && !styleOpen) || counts.errors > 0
    ? 'is-blocked'
    : editor.dirty
      ? 'is-dirty'
      : 'is-clean'
  const draftWhy = !open && !styleOpen
    ? '未打开模板'
    : counts.errors > 0
      ? `${counts.errors} 个错误 · 先修复`
      : editor.dirty
        ? '未保存 · 保存后写回文件'
        : '与文件一致'
  const draftLabel =
    !open && !styleOpen
      ? ''
      : counts.errors > 0
        ? `${counts.errors} 个错误`
        : editor.dirty
          ? '未保存'
          : ''

  const dirs = editor.snapshot?.dirs ?? []

  return (
    <div className="tpl-page">
      <header className="tpl-top">
        {/* 顶部不再顶一个「模板编辑」标题：左上角就是模板目录，标题只留给读屏 */}
        <h1 className="tpl-sr">模板编辑</h1>
        <label className="tpl-dir">
          <span className="tpl-dir-label">模板目录</span>
          <select
            className="tpl-select tpl-dir-select"
            value={editor.dir ?? ''}
            disabled={dirs.length === 0 || editor.busy}
            onChange={(event) => editor.requestDir(event.target.value)}
          >
            {dirs.map((item) => (
              <option key={item.dir} value={item.dir}>
                {item.dir}
              </option>
            ))}
            {dirs.length === 0 && (
              <option value="">
                {editor.status === 'ready' ? '（没配置模板目录）' : '正在读取…'}
              </option>
            )}
          </select>
        </label>
        <button
          type="button"
          className="tpl-icon-btn"
          disabled={editor.busy}
          title="重新加载模板目录"
          aria-label="重新加载"
          onClick={editor.requestReload}
        >
          <RefreshIcon />
        </button>
        <span className="tpl-top-counts">
          {/* 可数的东西不印：几个键、几个节点、几块内容，在列表与树里数得出来。
              这里只说"没打开"与"读不到骨架"这两件看不出来的事 */}
          {styleOpen && editor.style ? (
            editor.style.skeletonExists ? null : (
              <span className="tpl-count tpl-note-bad">骨架没读到</span>
            )
          ) : open ? null : (
            <span className="tpl-count">
              {editor.status === 'ready' ? '未打开模板' : '正在读取模板目录…'}
            </span>
          )}
        </span>
        <span className="tpl-top-gap" />
        {/* 右端并排：草稿状态灯（提示在按钮左侧）+ 保存 + 退出。
            灯三态——红=有错误（挡住保存）、琥珀=有未保存的改动、绿=与文件一致；
            文字只留最短一句，理由都在悬停提示里。 */}
        <span className={`tpl-draft ${draftState}`} title={draftWhy}>
          <span className="tpl-draft-dot" aria-hidden="true" />
          {draftLabel}
        </span>
        <button
          type="button"
          className="tpl-mini"
          disabled={!open || editor.busy || counts.errors > 0}
          title={
            !open
              ? '未打开结构模板'
              : counts.errors > 0
                ? `${counts.errors} 个错误 · 先修复`
                : '按这份模板导出 · 样式告警须为 0'
          }
          onClick={() => void editor.trialRun()}
        >
          试跑
        </button>
        {/* 能按的时候按钮自己写着"保存"：悬停只在灰着时给理由 */}
        <button
          type="button"
          className="tpl-mini tpl-primary"
          disabled={!canSave}
          title={saveWhy || undefined}
          onClick={() => void editor.save()}
        >
          保存
        </button>
        <button
          type="button"
          className="tpl-mini"
          onClick={closeTemplateEditor}
        >
          退出
        </button>
      </header>

      <div
        className="tpl-body"
        ref={bodyRef}
        style={{
          gridTemplateColumns: `${layout.list}px ${HANDLE}px ${layout.tree}px ${HANDLE}px minmax(0, 1fr)`
        }}
      >
        <TemplateList
          status={editor.status}
          dirSnapshot={editor.dirSnapshot}
          openKind={editor.openKind}
          openUuid={styleOpen ? (editor.styleEntry?.uuid ?? null) : (editor.entry?.uuid ?? null)}
          busy={editor.busy}
          dirty={editor.dirty}
          onOpen={editor.requestEntry}
          onOpenStyle={editor.requestStyle}
          onCreate={editor.createTemplate}
          onImport={editor.importStyle}
          onMigrate={editor.migrateDir}
          onPickDocx={() => window.documentor.dialog.selectDocx()}
          onPickDirectory={() => window.documentor.dialog.selectDirectory()}
          onRename={editor.renameTemplate}
          onRemove={editor.removeTemplate}
          onRenameStyle={editor.renameStyleEntry}
          onRemoveStyle={editor.removeStyleEntry}
        />
        <div
          className="tpl-split"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整模板列表宽度"
          tabIndex={0}
          onMouseDown={(event) => startDrag('list', event)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            nudge('list', event.key === 'ArrowLeft' ? -16 : 16)
          }}
        />
        {/* 样式视图占中栏与右栏两栏：一行五列，292px 的树栏里摆不下 */}
        {styleOpen ? (
          <StyleTable
            status={editor.status}
            result={editor.style}
            doc={editor.styleDoc}
            rows={editor.styleRows}
            issues={editor.issues}
            issuesFromServer={editor.issuesSource === 'server'}
            onMap={editor.patchStyleMap}
            onCaptionMode={editor.patchCaptionMode}
            onChapterStyleName={editor.patchChapterStyleName}
          />
        ) : (
          <>
            <NodeTree
              doc={editor.doc}
              status={editor.status}
              selectedPath={editor.selectedPath}
              expanded={editor.expanded}
              issues={editor.issues}
              onSelect={editor.selectNode}
              onToggle={editor.toggleExpand}
              onExpandAll={editor.expandAll}
              onCollapseAll={editor.collapseAll}
              onAddChild={editor.addChildAt}
              onAddSibling={editor.addSiblingAt}
              onDuplicate={editor.duplicateNodeAt}
              onMove={editor.moveNodeAt}
              onRemove={editor.removeNodeAt}
              onToggleBranch={editor.toggleBranchAt}
            />
            <div
              className="tpl-split"
              role="separator"
              aria-orientation="vertical"
              aria-label="调整节点树宽度"
              tabIndex={0}
              onMouseDown={(event) => startDrag('tree', event)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                nudge('tree', event.key === 'ArrowLeft' ? -16 : 16)
              }}
            />
            <NodeForm
              doc={editor.doc}
              status={editor.status}
              node={editor.selectedNode}
              path={editor.selectedPath}
              issues={nodeIssues}
              styles={editor.dirSnapshot?.styles ?? []}
              onPatch={editor.patchSelectedNode}
              onGroupFix={() => editor.fixGroupAt(editor.selectedPath)}
              onBlockPatch={editor.patchBlock}
              onBlockMove={editor.moveBlock}
              onBlockRemove={editor.removeBlock}
              onBlockAdd={editor.addBlock}
              onBlockDuplicate={editor.duplicateBlock}
              onPickImage={() => window.documentor.dialog.selectImage()}
            />
          </>
        )}
      </div>

      <footer className="tpl-foot">
        {/* 状态栏固定一行高，里面的东西再长也不许把它撑起来（撑起来就会挤三栏，很难看）。
            这一条上的消息分三类：
              ① 要你先点一下的确认（未保存改动）——文字与两个按钮都摆在这一行上；
              ② 一次操作的回执（已保存/已新建/已删除/已改名，失败时带原因）——一行摘要，
                 备份位置与报错原文这类长内容点「详情」弹浮层；
              ③ 校验小结（几个错误、几处提示）——点开是"问题在哪"的索引，浮层里按位置归堆，
                 逐条原话在节点详情里说（那里才是动手改的地方），这里不重复。 */}
        {editor.pending ? (
          <div
            className="tpl-status tpl-status-warn tpl-status-alert"
            role="alertdialog"
            aria-label="有未保存的改动"
          >
            <span className="tpl-status-text">
              {editor.pending.kind === 'reload'
                ? '未保存的改动 · 重新加载将丢弃'
                : '未保存的改动 · 换模板将丢弃'}
            </span>
            <button type="button" className="tpl-mini" onClick={editor.cancelPending}>
              取消
            </button>
            <button type="button" className="tpl-mini tpl-danger" onClick={editor.confirmPending}>
              {editor.pending.kind === 'reload' ? '丢掉改动并重新加载' : '丢掉改动并切换'}
            </button>
          </div>
        ) : (
          editor.notice && (
            <div
              className={`tpl-status tpl-status-${editor.notice.kind}`}
              role={editor.notice.kind === 'error' ? 'alert' : 'status'}
            >
              <span className="tpl-status-text">{editor.notice.text}</span>
              {editor.notice.detail && (
                <Popover
                  label={editor.notice.kind === 'error' ? '报错原文' : '备份位置'}
                  kind={editor.notice.kind}
                  text={editor.notice.detail}
                />
              )}
              <button
                type="button"
                className="tpl-icon-btn"
                title="关闭"
                aria-label="关闭提示"
                onClick={editor.dismissNotice}
              >
                <CloseIcon size={13} />
              </button>
            </div>
          )
        )}
        <div className="tpl-foot-issues">
          {editor.issues.length === 0 ? (
            <span className="tpl-count">{open || styleOpen ? '校验通过' : ''}</span>
          ) : (
            <IssueIndex
              groups={issueGroups}
              errors={counts.errors}
              warnings={counts.warnings}
              fromServer={editor.issuesSource === 'server'}
              {...(styleOpen ? {} : { onJump: editor.revealNode })}
            />
          )}
        </div>
      </footer>
    </div>
  )
}

/**
 * 一条状态上的长内容（备份路径 / 报错原文）：默认收着，点开是**浮层**——
 * 铺在状态栏里会把这一条撑高，三栏跟着缩一截，看着像页面在抖。
 */
function Popover({ label, kind, text }: { label: string; kind: string; text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <span className="tpl-pop-host">
      <button
        type="button"
        className="tpl-pop-trigger"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open && (
        <span className={`tpl-pop${kind === 'error' ? ' is-error' : ''}`} role="region" aria-label={label}>
          <code className="tpl-pop-text" title={text}>
            {text}
          </code>
        </span>
      )}
    </span>
  )
}

/**
 * 校验小结与"问题在哪"的索引：小结常驻一行，索引点开是浮层。
 * 浮层里只写位置与条数（能跳的做成按钮）——逐条原话在节点详情视图里说，
 * 同一句话在状态栏再说一遍就是重复传达。
 *
 * 两处例外，都是"原话没有别的落点"：整份模板级的结论（位置说不清），
 * 以及样式侧（对照表行说的是另一件事，校验原话只在这里出现，见 `groupStyleIssues`）。
 * 样式侧的组没有可跳的节点，位置只是个人读的标签，所以 `path` 是 null、`onJump` 不传。
 */
function IssueIndex({
  groups,
  errors,
  warnings,
  fromServer,
  onJump
}: {
  groups: IssueGroup[]
  errors: number
  warnings: number
  fromServer: boolean
  onJump?: (path: NodePath) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <span className="tpl-pop-host">
      {/* 结论是草稿现算的就不挂提示：这一行自己写着"几个错误、几处提示" */}
      <button
        type="button"
        className="tpl-pop-trigger tpl-foot-summary"
        aria-expanded={open}
        title={fromServer ? '主进程给出的结论' : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {errors} 个错误 · {warnings} 处提示
        <span className="tpl-pop-caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <span className="tpl-pop tpl-pop-wide" role="region" aria-label="问题在哪">
          {groups.map((group) => (
            <span className="tpl-pop-row" key={group.where ?? '(doc)'}>
              {/* 没有位置的（整份模板级的结论）不写位置标签：这一行开头就是条数 */}
              {group.where !== null &&
                (group.path && onJump ? (
                  <button
                    type="button"
                    className="tpl-pop-where"
                    title="跳到该节点"
                    onClick={() => onJump(group.path as NodePath)}
                  >
                    {group.where}
                  </button>
                ) : (
                  <span className="tpl-pop-where is-plain">{group.where}</span>
                ))}
              {group.errors > 0 && (
                <span className="tpl-badge tpl-badge-error">{group.errors} 个错误</span>
              )}
              {group.warnings > 0 && (
                <span className="tpl-badge tpl-badge-warn">{group.warnings} 处提示</span>
              )}
              {/* 位置说不清的与样式侧的结论只有这儿能说，带上原话 */}
              {group.messages.map((message) => (
                <span className="tpl-pop-msg" key={message}>
                  {message}
                </span>
              ))}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}
