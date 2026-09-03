/**
 * 检查器：节点只读元信息 + 编制说明编辑 + 视图切换（编辑/预览）+ 文档统计。
 */
import { useEffect, useRef, useState } from 'react'
import { countTree } from '../../state/treeUtils'
import { useApp, useSelectedNode } from '../../state/AppContext'

export type EditorView = 'edit' | 'preview'

export default function Inspector({
  view,
  onViewChange
}: {
  view: EditorView
  onViewChange: (v: EditorView) => void
}): React.JSX.Element {
  const { session, setNodeDescription } = useApp()
  const node = useSelectedNode()
  const [desc, setDesc] = useState(node?.description ?? '')
  const timerRef = useRef<number | undefined>(undefined)
  const valueRef = useRef(desc)
  const nodeRef = useRef(node)

  useEffect(() => {
    valueRef.current = desc
  }, [desc])

  useEffect(() => {
    setDesc(node?.description ?? '')
    nodeRef.current = node
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id])

  // 卸载/切换前提交挂起的描述编辑
  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current)
      const target = nodeRef.current
      if (target && valueRef.current !== target.description) {
        void setNodeDescription(target.id, valueRef.current)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const onDescChange = (value: string): void => {
    setDesc(value)
    window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      const target = nodeRef.current
      if (target && value !== target.description) {
        void setNodeDescription(target.id, value)
      }
    }, 600)
  }

  const stats = session ? countTree(session.root) : null

  return (
    <aside className="inspector">
      <div className="insp-scroll">
        <section className="insp-section">
          <h3 className="insp-title">视图</h3>
          <div className="insp-view-toggle">
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
          {view === 'preview' && (
            <p className="insp-note">静态渲染：排版规则与导出一致（表题注上、图题注下）。</p>
          )}
        </section>

        {node && (
          <section className="insp-section">
            <h3 className="insp-title">节点信息</h3>
            <dl className="insp-dl">
              <dt>标识</dt>
              <dd className="insp-mono">{node.id}</dd>
              {node.isSubTitle && (
                <>
                  <dt>子标题</dt>
                  <dd>
                    风格 {node.subTitleStyle}
                    {node.subTitleAutoNumber ? ' · 自动编号' : ' · 手动'}
                  </dd>
                </>
              )}
              <dt>权限</dt>
              <dd>
                <span className="insp-chip">{node.copyable ? '可复制' : '不可复制'}</span>
                <span className="insp-chip">{node.deletable ? '可删除' : '不可删除'}</span>
                <span className="insp-chip">
                  {node.allowContentBlocks ? '允许内容块' : '禁内容块'}
                </span>
              </dd>
              <dt>编制说明</dt>
              <dd>
                <textarea
                  className="insp-textarea"
                  value={desc}
                  onChange={(e) => onDescChange(e.target.value)}
                  placeholder="（无）"
                  rows={5}
                />
              </dd>
            </dl>
          </section>
        )}

        {session && (
          <section className="insp-section">
            <h3 className="insp-title">文档</h3>
            <dl className="insp-dl">
              <dt>模板</dt>
              <dd title={session.info.templateName}>{session.info.templateName}</dd>
              <dt>统计</dt>
              <dd>{stats ? `${stats.nodes} 节点 · ${stats.blocks} 内容块` : ''}</dd>
              <dt>位置</dt>
              <dd className="insp-mono insp-path" title={session.info.projectDir}>
                {session.info.projectDir}
              </dd>
            </dl>
          </section>
        )}
      </div>
    </aside>
  )
}
