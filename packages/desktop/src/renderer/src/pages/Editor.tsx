/**
 * 主编辑界面：结构栏(可拖宽) + 节点页/预览（工具行：左侧撤销/重做与历史，右侧视图开关）
 * + 底部状态栏。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../state/AppContext'
import TreePanel from '../components/editor/TreePanel'
import NodePage from '../components/editor/NodePage'
import StatusBar from '../components/editor/StatusBar'
import { PreviewPage } from '../components/editor/PreviewPage'
import { ViewToggle } from '../components/editor/ViewToggle'
import { HistoryControls } from '../components/editor/HistoryControls'
import '../components/editor/editor.css'

export type EditorView = 'edit' | 'preview'

const TREE_MIN = 180
const TREE_MAX = 520
const TREE_WIDTH_KEY = 'layout.treeWidth'
/** 上次用的是哪个视图：按工程记在 ui_state 里 */
const VIEW_KEY = 'editor_view'

function readTreeWidth(): number {
  try {
    const v = Number.parseInt(localStorage.getItem(TREE_WIDTH_KEY) ?? '', 10)
    if (Number.isFinite(v)) return Math.min(TREE_MAX, Math.max(TREE_MIN, v))
  } catch {
    /* 忽略：读不到宽度就用默认值 */
  }
  return 272
}

export default function Editor(): React.JSX.Element {
  const { session, busy, flushAll } = useApp()
  const [view, setView] = useState<EditorView>('edit')
  const [treeWidth, setTreeWidth] = useState(readTreeWidth)
  const treeWidthRef = useRef(treeWidth)

  /**
   * 切视图前先提交挂起编辑：预览读的是工程数据，而编辑区有 600ms 防抖缓冲，
   * 不 flush 就会看到"编辑一半时"的旧样子。
   */
  const changeView = useCallback(
    (next: EditorView) => {
      if (next === view) return
      void flushAll()
      setView(next)
      // 记住这个选择：下次打开工程还停在上次看的那一边
      void window.documentor.uiState.save(VIEW_KEY, next).catch(() => undefined)
    },
    [flushAll, view]
  )

  const sessionKey = session?.info.dprojPath ?? ''
  useEffect(() => {
    let disposed = false
    void window.documentor.uiState
      .load(VIEW_KEY)
      .then((saved) => {
        if (disposed) return
        setView(saved === 'preview' ? 'preview' : 'edit')
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [sessionKey])

  /** Ctrl+P 在编辑与预览之间切换（应用没有打印功能，这个组合空着） */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey || event.shiftKey || event.altKey) return
      if (event.key !== 'p' && event.key !== 'P') return
      event.preventDefault()
      changeView(view === 'edit' ? 'preview' : 'edit')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [changeView, view])

  useEffect(() => {
    treeWidthRef.current = treeWidth
  }, [treeWidth])

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    document.body.classList.add('is-splitting')
    const onMove = (ev: MouseEvent): void => {
      setTreeWidth(Math.min(TREE_MAX, Math.max(TREE_MIN, ev.clientX)))
    }
    const onUp = (): void => {
      document.body.classList.remove('is-splitting')
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      try {
        localStorage.setItem(TREE_WIDTH_KEY, String(treeWidthRef.current))
      } catch {
        /* 忽略：写不进去也不影响本次使用 */
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])

  return (
    <div className="editor-shell">
      <div
        className="editor-workspace"
        style={{ gridTemplateColumns: `${treeWidth}px 5px minmax(0, 1fr)` }}
      >
        <TreePanel />
        <div
          className="split-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="调整结构栏宽度"
          onMouseDown={onDragStart}
        />
        <div className="editor-stage">
          <div className="stage-toolbar">
            <HistoryControls />
            <ViewToggle view={view} onViewChange={changeView} />
          </div>
          {view === 'edit' ? <NodePage /> : <PreviewPage />}
        </div>
        {busy && (
          <div className="busy-overlay" role="status" aria-live="polite">
            <div className="busy-spinner" />
            <span>处理中…</span>
          </div>
        )}
        <span className="sr-only">{session ? `已打开工程：${session.info.name}` : ''}</span>
      </div>
      <StatusBar />
    </div>
  )
}
