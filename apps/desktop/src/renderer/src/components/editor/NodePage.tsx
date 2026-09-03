/**
 * 节点文档页：标题行内编辑 + 内容块流（编辑缓存 → 防抖提交 + 切换/保存 flush）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ContentBlock } from '@documentor/core/blocks'
import { useApp, useSelectedNode } from '../../state/AppContext'
import { BlockCard } from './BlockCard'
import type { LightboxRequest } from './BlockEditors'
import { BLOCK_ADD_ORDER, BLOCK_TYPE_LABELS, describeBlockType } from './blockTypes'
import { Lightbox } from '../Lightbox'

const DEBOUNCE_MS = 600

export default function NodePage(): React.JSX.Element {
  const node = useSelectedNode()
  const {
    addContentBlock,
    removeContentBlock,
    moveContentBlock,
    updateContentBlock,
    setNodeTitle,
    registerFlushAll,
    flushAll
  } = useApp()

  const [blocks, setBlocks] = useState<ContentBlock[]>(node?.contentBlocks ?? [])
  const [lightbox, setLightbox] = useState<LightboxRequest | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const pendingRef = useRef(new Map<number, ContentBlock>())
  const timersRef = useRef(new Map<number, number>())
  const nodeIdRef = useRef<string | null>(null)

  // 切换节点/挂载：重建缓存视图
  useEffect(() => {
    nodeIdRef.current = node?.id ?? null
    setBlocks(node?.contentBlocks ?? [])
    pendingRef.current.clear()
    for (const timer of timersRef.current.values()) window.clearTimeout(timer)
    timersRef.current.clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id])

  const flushPending = useCallback(() => {
    for (const [index, block] of [...pendingRef.current]) {
      const timer = timersRef.current.get(index)
      if (timer !== undefined) window.clearTimeout(timer)
      pendingRef.current.delete(index)
      timersRef.current.delete(index)
      const nodeId = nodeIdRef.current
      if (nodeId) void updateContentBlock(nodeId, index, block)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateContentBlock])

  // 向 store 注册本页 flush（保存/关闭/切换节点前调用）
  useEffect(() => registerFlushAll(flushPending), [registerFlushAll, flushPending])

  // 卸载时提交挂起编辑
  useEffect(() => () => flushPending(), [flushPending])

  const handleChange = useCallback(
    (index: number, block: ContentBlock) => {
      setBlocks((prev) => prev.map((b, i) => (i === index ? block : b)))
      pendingRef.current.set(index, block)
      const prevTimer = timersRef.current.get(index)
      if (prevTimer !== undefined) window.clearTimeout(prevTimer)
      const nodeId = nodeIdRef.current
      const timer = window.setTimeout(() => {
        pendingRef.current.delete(index)
        timersRef.current.delete(index)
        if (nodeId) void updateContentBlock(nodeId, index, block)
      }, DEBOUNCE_MS)
      timersRef.current.set(index, timer)
    },
    [updateContentBlock]
  )

  const handleAdd = useCallback(
    async (type: (typeof BLOCK_ADD_ORDER)[number]) => {
      const nodeId = nodeIdRef.current
      if (!nodeId) return
      await flushPending()
      await addContentBlock(nodeId, type)
    },
    [flushPending, addContentBlock]
  )

  const handleRemove = useCallback(
    async (index: number) => {
      const nodeId = nodeIdRef.current
      if (!nodeId) return
      await flushPending()
      await removeContentBlock(nodeId, index)
    },
    [flushPending, removeContentBlock]
  )

  const handleMove = useCallback(
    async (index: number, direction: -1 | 1) => {
      const nodeId = nodeIdRef.current
      if (!nodeId) return
      await flushPending()
      await moveContentBlock(nodeId, index, index + direction)
    },
    [flushPending, moveContentBlock]
  )

  if (!node) {
    return (
      <main className="node-page node-page-empty">
        <div className="np-hint">从左侧结构树选择节点进行编辑</div>
      </main>
    )
  }

  const canEditBlocks = node.allowContentBlocks
  const flags = {
    copyable: node.copyable,
    deletable: node.deletable,
    allowContentBlocks: node.allowContentBlocks,
    isSubTitle: node.isSubTitle
  }

  return (
    <main className="node-page">
      <div className="np-scroll">
        <article className="np-article">
          <div className="np-head">
            <input
              className="np-title"
              defaultValue={node.title}
              key={node.id}
              aria-label="节点标题"
              onBlur={(e) => {
                void setNodeTitle(node.id, e.target.value)
              }}
            />
            <div className="np-badges">
              {node.headingLevel === 0 ? (
                <span className="np-badge">文档根</span>
              ) : flags.isSubTitle ? (
                <span className="np-badge np-badge-sub">子标题</span>
              ) : (
                <span className="np-badge">标题级别 {node.headingLevel}</span>
              )}
              <span className="np-flag" title="允许复制">
                {flags.copyable ? '可复制' : ''}
              </span>
              <span className="np-flag" title="允许删除">
                {flags.deletable ? '可删除' : ''}
              </span>
            </div>
          </div>

          {node.description && node.description !== '无' && (
            <p className="np-description" title="模板编制说明">
              {node.description}
            </p>
          )}

          {!canEditBlocks && node.contentBlocks.length === 0 ? (
            <div className="np-block-hint">该模板节点不允许挂内容块</div>
          ) : (
            <div className="np-blocks">
              {blocks.map((block, index) => (
                <BlockCard
                  key={`${node.id}:${index}`}
                  nodeId={node.id}
                  index={index}
                  block={block}
                  canMoveUp={index > 0}
                  canMoveDown={index < blocks.length - 1}
                  onChange={handleChange}
                  onMove={(i, d) => void handleMove(i, d)}
                  onRemove={(i) => void handleRemove(i)}
                  onPreview={(req) => setLightbox(req)}
                />
              ))}
              {canEditBlocks && (
                <div className="np-add">
                  <button
                    type="button"
                    className="np-add-btn"
                    onClick={() => setAddOpen((v) => !v)}
                    aria-expanded={addOpen}
                  >
                    ＋ 添加内容块
                  </button>
                  {addOpen && (
                    <div className="np-add-menu">
                      {BLOCK_ADD_ORDER.map((type) => (
                        <button
                          key={type}
                          type="button"
                          title={describeBlockType(type)}
                          onClick={() => {
                            setAddOpen(false)
                            void handleAdd(type)
                          }}
                        >
                          <span className="np-add-label">{BLOCK_TYPE_LABELS[type]}</span>
                          <span className="np-add-desc">{describeBlockType(type)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </article>
      </div>
      {lightbox && <Lightbox request={lightbox} onClose={() => setLightbox(null)} />}
    </main>
  )
}
