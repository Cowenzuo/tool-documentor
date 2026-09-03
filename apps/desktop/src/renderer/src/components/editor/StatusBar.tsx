/**
 * 底部状态栏：视图切换（编辑/预览） + 文档统计 + 模板/路径。
 */
import { countTree } from '../../state/treeUtils'
import { useApp } from '../../state/AppContext'
import type { EditorView } from '../../pages/Editor'

export default function StatusBar({
  view,
  onViewChange
}: {
  view: EditorView
  onViewChange: (v: EditorView) => void
}): React.JSX.Element | null {
  const { session } = useApp()
  if (!session) return null
  const stats = countTree(session.root)

  return (
    <footer className="statusbar">
      <div className="statusbar-view">
        <span className="statusbar-label">视图</span>
        <div className="status-view-toggle" role="tablist" aria-label="视图切换">
          <button
            type="button"
            className={view === 'edit' ? 'active' : ''}
            onClick={() => onViewChange('edit')}
          >
            编辑
          </button>
          <button
            type="button"
            className={view === 'preview' ? 'active' : ''}
            title="以文档排版渲染当前节点"
            onClick={() => onViewChange('preview')}
          >
            预览
          </button>
        </div>
      </div>
      <div className="statusbar-stats">
        {stats.nodes} 节点 · {stats.blocks} 内容块
      </div>
      <div
        className="statusbar-meta"
        title={`${session.info.templateName}\n${session.info.projectDir}`}
      >
        <span className="statusbar-meta-main">{session.info.templateName}</span>
        <span className="statusbar-meta-path">{session.info.projectDir}</span>
      </div>
    </footer>
  )
}
