/**
 * 底部状态栏：文档统计 + 模板/路径（视图切换已移至编辑区顶部右侧）。
 */
import { countTree } from '../../state/treeUtils'
import { useApp } from '../../state/AppContext'

export default function StatusBar(): React.JSX.Element | null {
  const { session } = useApp()
  if (!session) return null
  const stats = countTree(session.root)
  // 模板认不到时状态栏不能空着：空着看不出是"没模板"还是界面坏了
  const templateLabel = session.info.templateName !== '' ? session.info.templateName : '模板未认到'
  const templateTitle =
    session.info.templateName !== ''
      ? session.info.templateName
      : `模板未认到：${session.info.legacyTemplateName || session.info.templateUuid || '未记引用'}`

  return (
    <footer className="statusbar">
      <div className="statusbar-stats">
        {stats.nodes} 章节 · {stats.blocks} 项内容
      </div>
      <div className="statusbar-meta" title={`${templateTitle}\n${session.info.projectDir}`}>
        <span className="statusbar-meta-main">{templateLabel}</span>
        <span className="statusbar-meta-path">{session.info.projectDir}</span>
      </div>
    </footer>
  )
}
