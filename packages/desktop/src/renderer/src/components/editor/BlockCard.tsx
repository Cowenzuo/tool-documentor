/**
 * 内容块卡片：类型徽标 + 锁标记 + 折叠开关 + 操作按钮（悬停浮现）+ 编辑器体。
 * 折叠后只留一行摘要，长章节里一屏能扫过更多块。
 */
import type { BlockLockLevel, ContentBlock } from '@documentor/core/blocks'
import { blockTierOf } from '../../../../shared/permissionTerms'
import {
  CodeEditor,
  FormulaEditor,
  ImageEditor,
  ListEditor,
  MermaidEditor,
  TableEditor,
  TextEditor,
  type LightboxRequest
} from './BlockEditors'
import { BLOCK_TYPE_BADGES, BLOCK_TYPE_LABELS, summarizeBlock } from './blockTypes'

/**
 * 卡片头上的档位标记与提示：词与模板编辑器那三档同一份（见 shared/permissionTerms）。
 * 提示里只讲模板的规定与还能做什么，不写"不可编辑"这类喊话式文案。
 */
function lockTagText(lock: BlockLockLevel): string {
  return blockTierOf(lock).tag ?? blockTierOf(lock).name
}

function lockTagTitle(lock: BlockLockLevel): string {
  return blockTierOf(lock).tip
}

/** 按钮置灰的原因：按档位说清为什么这件事做不了 */
function lockReason(lock: BlockLockLevel, what: 'remove' | 'move'): string {
  const head = lock === 'readonly' ? '模板规定该内容为只读' : '模板规定该内容必须存在'
  return what === 'remove' ? `${head}，不能删除` : `${head}，不能移动`
}

export interface BlockCardProps {
  nodeId: string
  index: number
  block: ContentBlock
  canMoveUp: boolean
  canMoveDown: boolean
  /** 相邻块是 keep/readonly 档：交换位置会把它挪走，写入侧也会拒绝 */
  neighborLockedUp?: boolean
  neighborLockedDown?: boolean
  collapsed: boolean
  onToggleCollapse: (index: number) => void
  onChange: (index: number, block: ContentBlock) => void
  onMove: (index: number, direction: -1 | 1) => void
  onRemove: (index: number) => void
  onPreview?: (req: LightboxRequest) => void
  showMeta?: boolean
}

export function BlockCard(props: BlockCardProps): React.JSX.Element {
  const {
    block,
    index,
    collapsed,
    onToggleCollapse,
    onChange,
    onMove,
    onRemove,
    canMoveUp,
    canMoveDown,
    neighborLockedUp,
    neighborLockedDown
  } = props
  const change = (next: ContentBlock): void => onChange(index, next)
  const lock = block.lock
  /**
   * 档位的可做项：`keep` 与 `readonly` 不能删也不能挪，作废的 `type` 只锁类型。
   * 块类型在这套编辑器里没有切换控件，类型一律在写入侧拦（见 project-service 的 updateBlock），
   * 卡片上只用档位标记与提示交代模板的规定。
   */
  const keepLocked = lock === 'keep' || lock === 'readonly'
  const moveUp = canMoveUp && !keepLocked && !neighborLockedUp
  const moveDown = canMoveDown && !keepLocked && !neighborLockedDown
  // 交换是双向的：相邻块被模板钉住时，本块也挪不过去，原因要照样说清
  const neighborReason = '相邻内容是模板规定不能移动的，交换位置会把它挪走'
  const moveUpTitle = keepLocked && lock ? lockReason(lock, 'move') : neighborLockedUp ? neighborReason : null
  const moveDownTitle = keepLocked && lock ? lockReason(lock, 'move') : neighborLockedDown ? neighborReason : null
  const removeTitle = keepLocked && lock ? lockReason(lock, 'remove') : null

  /**
   * 卡片级快捷键：Alt+↑/↓ 移动本块，Ctrl+Enter 折叠/展开。
   * 事件从编辑器里冒泡上来，所以光标在文本域里也能用。
   */
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      if (event.key === 'ArrowUp' ? moveUp : moveDown) {
        onMove(index, event.key === 'ArrowUp' ? -1 : 1)
      }
      return
    }
    if (event.ctrlKey && event.key === 'Enter') {
      event.preventDefault()
      onToggleCollapse(index)
    }
  }

  return (
    <section
      className={`block-card type-${block.type}${collapsed ? ' is-collapsed' : ''}`}
      onKeyDown={onKeyDown}
    >
      <header className="block-card-head">
        <button
          type="button"
          className="block-card-collapse"
          title={collapsed ? '展开此内容（Ctrl+Enter）' : '折叠此内容（Ctrl+Enter）'}
          aria-label={collapsed ? '展开此内容' : '折叠此内容'}
          aria-expanded={!collapsed}
          onClick={() => onToggleCollapse(index)}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" className={collapsed ? '' : 'open'}>
            <path d="M5 3.5 10.5 8 5 12.5Z" fill="currentColor" />
          </svg>
        </button>
        <span className="block-type-badge" aria-hidden="true">
          {BLOCK_TYPE_BADGES[block.type]}
        </span>
        <span className="block-type-label">{BLOCK_TYPE_LABELS[block.type]}</span>
        {lock && (
          <span className="block-lock-tag" title={lockTagTitle(lock)}>
            {lockTagText(lock)}
          </span>
        )}
        {collapsed && <span className="block-card-summary">{summarizeBlock(block)}</span>}
        <span className="block-card-actions">
          <button
            type="button"
            className="be-icon-btn"
            title={moveUpTitle ?? '上移（Alt+↑）'}
            aria-label="上移此内容"
            disabled={!moveUp}
            onClick={() => onMove(index, -1)}
          >
            <svg viewBox="0 0 16 16" width="13" height="13">
              <path d="M8 2.5 13 8h-3v5H6V8H3Z" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="be-icon-btn"
            title={moveDownTitle ?? '下移（Alt+↓）'}
            aria-label="下移此内容"
            disabled={!moveDown}
            onClick={() => onMove(index, 1)}
          >
            <svg viewBox="0 0 16 16" width="13" height="13">
              <path d="m8 13.5-5-5.5h3V3h4v5h3Z" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="be-icon-btn danger"
            title={removeTitle ?? '删除此内容'}
            aria-label="删除此内容"
            disabled={keepLocked}
            onClick={() => onRemove(index)}
          >
            <svg viewBox="0 0 16 16" width="13" height="13">
              <path
                d="M6.5 2h3l.5.5V4H12v1H4V4h2V2.5Zm-2 3h7l-.6 8.1a1 1 0 0 1-1 .9H6.1a1 1 0 0 1-1-.9Z"
                fill="currentColor"
              />
            </svg>
          </button>
        </span>
      </header>
      {!collapsed && (
        <div className="block-card-body">
          <BlockBody {...props} change={change} />
        </div>
      )}
    </section>
  )
}

function BlockBody(props: BlockCardProps & { change: (b: ContentBlock) => void }): React.JSX.Element {
  const { block, change, onPreview } = props
  /** `readonly` 档的内容由模板给定：编辑器只呈现，不接收改动 */
  const readOnly = block.lock === 'readonly'
  switch (block.type) {
    case 'text':
      return <TextEditor block={block} onChange={change} readOnly={readOnly} />
    case 'image':
      return <ImageEditor block={block} onChange={change} onPreview={onPreview} readOnly={readOnly} />
    case 'table':
      return <TableEditor block={block} onChange={change} readOnly={readOnly} />
    case 'formula':
      return <FormulaEditor block={block} onChange={change} readOnly={readOnly} />
    case 'code':
      return <CodeEditor block={block} onChange={change} readOnly={readOnly} />
    case 'mermaid':
      return <MermaidEditor block={block} onChange={change} onPreview={onPreview} readOnly={readOnly} />
    case 'orderedList':
      return <ListEditor block={block} onChange={change} ordered readOnly={readOnly} />
    case 'unorderedList':
      return <ListEditor block={block} onChange={change} ordered={false} readOnly={readOnly} />
  }
}
