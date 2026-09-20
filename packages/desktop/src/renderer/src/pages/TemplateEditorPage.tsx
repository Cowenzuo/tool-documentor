/**
 * 模板编辑页（PLAN-11 批次 2）：整页独立，不打开工程、不进撤销栈、不挂编辑器的组件树。
 * 三栏：左栏模板列表（目录与模板、问题徽标），中栏节点树，右栏选中节点的表单。
 * 改动只落在内存草稿里，写文件只发生在页脚那个「保存」按钮。
 *
 * 三栏可拖：左与中记宽度（本机 localStorage，口径同主编辑器的结构栏），右栏吃掉剩下的。
 * 窗口变窄时按比例收左与中，先保右栏的最小可用宽度——要填的字都在右栏。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useApp } from '../state/AppContext'
import NodeForm from '../components/template/NodeForm'
import NodeTree from '../components/template/NodeTree'
import TemplateList from '../components/template/TemplateList'
import { IssueLines } from '../components/template/fields'
import { countBlocks, countNodes, nodeJsonPath } from '../components/template/templateDoc'
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
  const hasErrors = counts.errors > 0
  const open = editor.doc !== null

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

  /**
   * 问题清单的展开状态：出现 error 时自动摊开，之后由用户自己开关。
   * 不直接把 open 绑到 counts.errors 上——那样每敲一个字都会被重新渲染按回去。
   */
  const [issuesOpen, setIssuesOpen] = useState(false)
  useEffect(() => {
    if (hasErrors) setIssuesOpen(true)
  }, [hasErrors])

  const nodeIssues = editor.selectedNode
    ? issuesUnder(editor.issues, nodeJsonPath(editor.selectedPath))
    : []

  /** 保存按钮为什么不能按：一句话说清，按钮上也有同样的 title */
  const saveWhy = !open
    ? '没有打开模板'
    : counts.errors > 0
      ? `有 ${counts.errors} 个错误，先改好再保存`
      : !editor.dirty
        ? '没有未保存的改动'
        : editor.busy
          ? '正在处理…'
          : ''
  const canSave = open && editor.dirty && counts.errors === 0 && !editor.busy

  const dirs = editor.snapshot?.dirs ?? []

  return (
    <div className="tpl-page">
      <header className="tpl-top">
        <h1 className="tpl-top-title">模板编辑</h1>
        <label className="tpl-dir">
          <span className="tpl-count">模板目录</span>
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
          className="tpl-mini"
          disabled={editor.busy}
          onClick={editor.requestReload}
        >
          重新加载
        </button>
        <span className="tpl-top-counts">
          {open ? (
            <>
              <span className="tpl-count">
                {countNodes(editor.doc)} 个节点 · {countBlocks(editor.doc)} 个内容块
              </span>
              {counts.errors > 0 && (
                <span className="tpl-badge tpl-badge-error">{counts.errors} 个错误</span>
              )}
              {counts.warnings > 0 && (
                <span className="tpl-badge tpl-badge-warn">{counts.warnings} 处提示</span>
              )}
              {counts.errors === 0 && counts.warnings === 0 && (
                <span className="tpl-count">没有发现问题</span>
              )}
            </>
          ) : (
            <span className="tpl-count">
              {editor.status === 'ready' ? '没有打开模板' : '正在读取模板目录…'}
            </span>
          )}
        </span>
        <span className="tpl-top-gap" />
        {editor.dirty && <span className="tpl-dirty">改动未保存</span>}
        <button type="button" className="tpl-mini" onClick={closeTemplateEditor}>
          关闭
        </button>
      </header>

      {editor.pending && (
        <div className="tpl-strip tpl-strip-warn" role="alertdialog" aria-label="有未保存的改动">
          <span>
            {editor.pending.kind === 'reload'
              ? '有未保存的改动，重新加载就会丢掉。'
              : '有未保存的改动，换一份模板就会丢掉。'}
          </span>
          <button type="button" className="tpl-mini" onClick={editor.cancelPending}>
            取消
          </button>
          <button type="button" className="tpl-mini tpl-danger" onClick={editor.confirmPending}>
            {editor.pending.kind === 'reload' ? '丢掉改动并重新加载' : '丢掉改动并切换'}
          </button>
        </div>
      )}

      {editor.notice && (
        <div className={`tpl-strip tpl-strip-${editor.notice.kind}`}>
          <span>{editor.notice.text}</span>
          {editor.notice.detail &&
            (editor.notice.kind === 'error' ? (
              <code className="tpl-raw">{editor.notice.detail}</code>
            ) : (
              <details className="tpl-detail">
                <summary>备份位置</summary>
                <code className="tpl-path">{editor.notice.detail}</code>
              </details>
            ))}
          <button type="button" className="tpl-mini" aria-label="关闭提示" onClick={editor.dismissNotice}>
            ✕
          </button>
        </div>
      )}

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
          selectedId={editor.entry?.id ?? null}
          busy={editor.busy}
          dirty={editor.dirty}
          onOpen={editor.requestEntry}
          onCreate={editor.createTemplate}
          onRename={editor.renameTemplate}
          onRemove={editor.removeTemplate}
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
          nodeTypes={editor.nodeTypes}
          canMove={editor.canMoveSelected}
          onPatch={editor.patchSelectedNode}
          onAddChild={editor.addChildNode}
          onAddSibling={editor.addSiblingNode}
          onMove={editor.moveSelectedNode}
          onRemove={editor.removeSelectedNode}
          onBlockPatch={editor.patchBlock}
          onBlockMove={editor.moveBlock}
          onBlockRemove={editor.removeBlock}
          onBlockAdd={editor.addBlock}
        />
      </div>

      <footer className="tpl-foot">
        <div className="tpl-foot-issues">
          {editor.issues.length === 0 ? (
            <span className="tpl-count">{open ? '校验通过' : ''}</span>
          ) : (
            <details open={issuesOpen} onToggle={(event) => setIssuesOpen(event.currentTarget.open)}>
              <summary>
                {counts.errors} 个错误 · {counts.warnings} 处提示
                {editor.issuesSource === 'server' ? '（主进程的结论）' : ''}
              </summary>
              <div className="tpl-foot-issue-list">
                <IssueLines issues={editor.issues} />
              </div>
            </details>
          )}
        </div>
        <div className="tpl-foot-save">
          {editor.saveResult && (
            <>
              <span className="tpl-count">已保存 {editor.saveResult.savedAt.slice(11, 19)}</span>
              {editor.saveResult.backupPath ? (
                <details className="tpl-detail">
                  <summary>备份位置</summary>
                  <code className="tpl-path">{editor.saveResult.backupPath}</code>
                </details>
              ) : (
                <span className="tpl-count">首次保存，没有可备份的原文件</span>
              )}
            </>
          )}
          <button
            type="button"
            className="tpl-mini tpl-primary"
            disabled={!canSave}
            title={saveWhy || '写入这份模板文件'}
            onClick={() => void editor.save()}
          >
            保存
          </button>
          {saveWhy && <span className="tpl-count">{saveWhy}</span>}
        </div>
      </footer>
    </div>
  )
}
