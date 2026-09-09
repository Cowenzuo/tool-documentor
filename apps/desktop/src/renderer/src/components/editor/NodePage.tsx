/**
 * 节点文档页：标题行内编辑 + 节点信息徽标区 + 编制说明（可编辑）+ 内容块流。
 * 块编辑器挂起值经防抖提交；切换/保存前统一 flush（复刻 collectEdits 语义）。
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
    setNodeDescription,
    registerFlushAll
  } = useApp()

  const [blocks, setBlocks] = useState<ContentBlock[]>(node?.contentBlocks ?? [])
  const [desc, setDesc] = useState(node?.description ?? '')
  const [lightbox, setLightbox] = useState<LightboxRequest | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const pendingRef = useRef(new Map<number, ContentBlock>())
  const timersRef = useRef(new Map<number, number>())
  const nodeIdRef = useRef<string | null>(null)
  const descValueRef = useRef(desc)
  const descDirtyRef = useRef(false)
  const descTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    descValueRef.current = desc
  }, [desc])

  // 切换节点/挂载：重建缓存视图
  useEffect(() => {
    nodeIdRef.current = node?.id ?? null
    const initialDesc = node?.description ?? ''
    setBlocks(node?.contentBlocks ?? [])
    setDesc(initialDesc === '无' ? '' : initialDesc)
    descDirtyRef.current = false
    pendingRef.current.clear()
    for (const timer of timersRef.current.values()) window.clearTimeout(timer)
    timersRef.current.clear()
    window.clearTimeout(descTimerRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id])

  /** 提交全部挂起编辑（块 + 编制说明） */
  const flushPending = useCallback(() => {
    // 编制说明
    window.clearTimeout(descTimerRef.current)
    const nodeId = nodeIdRef.current
    if (descDirtyRef.current && nodeId) {
      descDirtyRef.current = false
      void setNodeDescription(nodeId, descValueRef.current)
    }
    // 内容块
    for (const [index, block] of [...pendingRef.current]) {
      const timer = timersRef.current.get(index)
      if (timer !== undefined) window.clearTimeout(timer)
      pendingRef.current.delete(index)
      timersRef.current.delete(index)
      if (nodeId) void updateContentBlock(nodeId, index, block)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setNodeDescription, updateContentBlock])

  // 向 store 注册本页 flush（保存/关闭/切换节点前调用）
  useEffect(() => registerFlushAll(flushPending), [registerFlushAll, flushPending])

  // 卸载时提交挂起编辑
  useEffect(() => () => flushPending(), [flushPending])

  const onDescChange = useCallback(
    (value: string) => {
      setDesc(value)
      descValueRef.current = value
      descDirtyRef.current = true
      window.clearTimeout(descTimerRef.current)
      descTimerRef.current = window.setTimeout(flushPending, DEBOUNCE_MS)
    },
    [flushPending]
  )

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
              ) : node.isSubTitle ? (
                <span className="np-badge np-badge-sub">子标题</span>
              ) : (
                <span className="np-badge">标题级别 {node.headingLevel}</span>
              )}
              <span
                className={`np-chip${node.copyable ? ' np-chip-ok' : ''}`}
                title="该节点允许复制"
              >
                {node.copyable ? '可复制' : '不可复制'}
              </span>
              <span
                className={`np-chip${node.deletable ? ' np-chip-ok' : ''}`}
                title="该节点允许删除"
              >
                {node.deletable ? '可删除' : '不可删除'}
              </span>
              <span
                className={`np-chip${canEditBlocks ? ' np-chip-ok' : ''}`}
                title="该节点允许添加内容块"
              >
                {canEditBlocks ? '可编辑' : '锁定'}
              </span>
            </div>
          </div>

          <textarea
            className="np-desc-editor"
            value={desc}
            onChange={(e) => onDescChange(e.target.value)}
            placeholder="编制说明（可选）…"
            aria-label="编制说明"
          />

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
