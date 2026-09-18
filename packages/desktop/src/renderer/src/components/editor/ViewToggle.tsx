/**
 * 视图切换（编辑 ⇄ 预览），置于节点页顶部右侧。
 */
import type { EditorView } from '../../pages/Editor'

export function ViewToggle({
  view,
  onViewChange
}: {
  view: EditorView
  onViewChange: (v: EditorView) => void
}): React.JSX.Element {
  return (
    <div className="view-toggle" role="tablist" aria-label="视图切换">
      <button
        type="button"
        className={view === 'edit' ? 'active' : ''}
        title="编辑（Ctrl+P 切换）"
        onClick={() => onViewChange('edit')}
      >
        编辑
      </button>
      <button
        type="button"
        className={view === 'preview' ? 'active' : ''}
        title="以文档排版显示整篇（Ctrl+P 切换）"
        onClick={() => onViewChange('preview')}
      >
        预览
      </button>
    </div>
  )
}
