/**
 * 主编辑界面：结构栏 + 中区（编辑/预览视图）+ 检查器。
 */
import { useState } from 'react'
import { useApp } from '../state/AppContext'
import TreePanel from '../components/editor/TreePanel'
import NodePage from '../components/editor/NodePage'
import Inspector, { type EditorView } from '../components/editor/Inspector'
import { PreviewPage } from '../components/editor/PreviewPage'
import '../components/editor/editor.css'

export default function Editor(): React.JSX.Element {
  const { session, busy } = useApp()
  const [view, setView] = useState<EditorView>('edit')

  return (
    <div className="editor-workspace">
      <TreePanel />
      {view === 'edit' ? <NodePage /> : <PreviewPage />}
      <Inspector view={view} onViewChange={setView} />
      {busy && (
        <div className="busy-overlay" role="status" aria-live="polite">
          <div className="busy-spinner" />
          <span>处理中…</span>
        </div>
      )}
      <span className="sr-only">{session ? `已打开工程：${session.info.name}` : ''}</span>
    </div>
  )
}
