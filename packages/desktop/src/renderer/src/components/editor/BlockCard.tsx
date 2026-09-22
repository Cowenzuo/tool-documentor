/**
 * 内容块卡片：类型徽标 + 档位标记 + 折叠开关 + 操作按钮（悬停浮现）+ 编辑器体。
 * 折叠后只留一行摘要，长章节里一屏能扫过更多块。
 */
import type { BlockLockLevel, ContentBlock } from '@documentor/core/blocks'
import {
  BLOCK_ACTION,
  blockTierOf,
  lockRefusal,
  reshapeRefusal,
  type BlockPermissions
} from '../../../../shared/permissionTerms'
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
export interface BlockCardProps {
  nodeId: string
  index: number
  block: ContentBlock
  /** 这一章的块权限（编辑 × 排版取交），与写入侧同一份判定 */
  perms: BlockPermissions
  canMoveUp: boolean
  canMoveDown: boolean
  collapsed: boolean
  onToggleCollapse: (index: number) => void
  onChange: (index: number, block: ContentBlock) => void
  onMove: (index: number, direction: -1 | 1) => void
  onRemove: (index: number) => void
  onPreview?: (req: LightboxRequest) => void
  /** 点卡片头上的类型名字：把菜单开在按钮下方（坐标由调用方按视口算） */
  onOpenTypeMenu?: (index: number, anchor: { x: number; y: number }) => void
  /** 菜单是否正开在这一块上 */
  typeMenuOpen?: boolean
  showMeta?: boolean
}

export function BlockCard(props: BlockCardProps): React.JSX.Element {
  const {
    block,
    index,
    perms,
    collapsed,
    onToggleCollapse,
    onChange,
    onMove,
    onRemove,
    canMoveUp,
    canMoveDown
  } = props
  const change = (next: ContentBlock): void => onChange(index, next)
  const lock = block.lock
  /**
   * 档位与两个总闸取交之后这一块能做什么（PLAN-13 第 1.3 节）：
   *   - 改内容：编辑开着且不是只读；
   *   - 挪动：排版开着就成，块档位不管顺序；
   *   - 删除与换形状：排版开着，且块上没有锁，类型限制编辑与只读都不行。
   * 换类型的入口在卡片头的类型名字上，置灰理由与写入侧的拒绝语同一句（见 PLAN-20）。
   */
  const moveUp = canMoveUp && perms.move
  const moveDown = canMoveDown && perms.move
  const removable = perms.remove && lock === undefined
  const shapeLocked = !perms.reshape || lock !== undefined
  const shapeLockedWhy = perms.reshape
    ? `${blockTierOf(lock).name}：${blockTierOf(lock).tip}`
    : '模板把这一章的排版关着'
  const typeTitle = shapeLocked ? reshapeRefusal(lock, perms) : BLOCK_ACTION.changeType.tip
  const moveUpTitle = perms.move ? '上移（Alt+↑）' : perms.whyMove
  const moveDownTitle = perms.move ? '下移（Alt+↓）' : perms.whyMove
  const removeTitle = removable
    ? '删除此内容'
    : lock !== undefined
      ? lockRefusal(lock, 'remove')
      : perms.whyRemove

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
        <span className="block-type-label">
          <button
            type="button"
            className="block-type-btn"
            title={typeTitle}
            aria-haspopup="menu"
            aria-expanded={props.typeMenuOpen === true}
            disabled={shapeLocked}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              props.onOpenTypeMenu?.(index, { x: rect.left, y: rect.bottom + 4 })
            }}
          >
            {BLOCK_TYPE_LABELS[block.type]}
          </button>
        </span>
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
            title={moveUpTitle}
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
            title={moveDownTitle}
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
            title={removeTitle}
            aria-label="删除此内容"
            disabled={!removable}
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
  /**
   * 形状锁：块档位不是自由编辑，或这一章的排版关着。
   * 表格的表头、行数列数与合并开关按它置灰，说法用同一句（见卡片头那次计算）。
   */
  const shapeLocked = !props.perms.reshape || block.lock !== undefined
  const shapeLockedWhy = props.perms.reshape
    ? `${blockTierOf(block.lock).name}：${blockTierOf(block.lock).tip}`
    : '模板把这一章的排版关着'
  switch (block.type) {
    case 'text':
      return <TextEditor block={block} onChange={change} readOnly={readOnly} />
    case 'image':
      return <ImageEditor block={block} onChange={change} onPreview={onPreview} readOnly={readOnly} />
    case 'table':
      return (
        <TableEditor
          block={block}
          onChange={change}
          readOnly={readOnly}
          shapeLocked={shapeLocked}
          shapeLockedWhy={shapeLockedWhy}
        />
      )
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
