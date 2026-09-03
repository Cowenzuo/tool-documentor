/**
 * 主编辑界面：结构栏(可拖宽) + 节点页/预览 + 底部状态栏。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../state/AppContext'
import TreePanel from '../components/editor/TreePanel'
import NodePage from '../components/editor/NodePage'
import StatusBar from '../components/editor/StatusBar'
import { PreviewPage } from '../components/editor/PreviewPage'
import '../components/editor/editor.css'

export type EditorView = 'edit' | 'preview'

const TREE_MIN = 180
const TREE_MAX = 520
const TREE_WIDTH_KEY = 'layout.treeWidth'

function readTreeWidth(): number {
  try {
    const v = Number.parseInt(localStorage.getItem(TREE_WIDTH_KEY) ?? '', 10)
    if (Number.isFinite(v)) return Math.min(TREE_MAX, Math.max(TREE_MIN, v))
  } catch {
    /* ignore */
  }
  return 272
}

export default function Editor(): React.JSX.Element {
  const { session, busy } = useApp()
  const [view, setView] = useState<EditorView>('edit')
  const [treeWidth, setTreeWidth] = useState(readTreeWidth)
  const treeWidthRef = useRef(treeWidth)

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
        /* ignore */
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
        {view === 'edit' ? <NodePage /> : <PreviewPage />}
        {busy && (
          <div className="busy-overlay" role="status" aria-live="polite">
            <div className="busy-spinner" />
            <span>处理中…</span>
          </div>
        )}
        <span className="sr-only">{session ? `已打开工程：${session.info.name}` : ''}</span>
      </div>
      <StatusBar view={view} onViewChange={setView} />
    </div>
  )
}
