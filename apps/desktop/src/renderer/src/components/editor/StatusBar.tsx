/**
 * 底部状态栏：文档统计 + 模板/路径（视图切换已移至编辑区顶部右侧）。
 */
import { countTree } from '../../state/treeUtils'
import { useApp } from '../../state/AppContext'

export default function StatusBar(): React.JSX.Element | null {
  const { session } = useApp()
  if (!session) return null
  const stats = countTree(session.root)

  return (
    <footer className="statusbar">
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
