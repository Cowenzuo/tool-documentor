/**
 * 内容块卡片：类型徽标 + 折叠开关 + 操作按钮（悬停浮现）+ 编辑器体。
 * 折叠后只留一行摘要，长章节里一屏能扫过更多块。
 */
import type { ContentBlock } from '@documentor/core/blocks'
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

export interface BlockCardProps {
  nodeId: string
  index: number
  block: ContentBlock
  canMoveUp: boolean
  canMoveDown: boolean
  collapsed: boolean
  onToggleCollapse: (index: number) => void
  onChange: (index: number, block: ContentBlock) => void
  onMove: (index: number, direction: -1 | 1) => void
  onRemove: (index: number) => void
  onPreview?: (req: LightboxRequest) => void
  showMeta?: boolean
}

export function BlockCard(props: BlockCardProps): React.JSX.Element {
  const { block, index, collapsed, onToggleCollapse, onChange, onMove, onRemove, canMoveUp, canMoveDown } = props
  const change = (next: ContentBlock): void => onChange(index, next)

  return (
    <section className={`block-card type-${block.type}${collapsed ? ' is-collapsed' : ''}`}>
      <header className="block-card-head">
        <button
          type="button"
          className="block-card-collapse"
          title={collapsed ? '展开此内容' : '折叠此内容'}
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
        {collapsed && <span className="block-card-summary">{summarizeBlock(block)}</span>}
        <span className="block-card-actions">
          <button
            type="button"
            className="be-icon-btn"
            title="上移"
            aria-label="上移此内容"
            disabled={!canMoveUp}
            onClick={() => onMove(index, -1)}
          >
            <svg viewBox="0 0 16 16" width="13" height="13">
              <path d="M8 2.5 13 8h-3v5H6V8H3Z" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="be-icon-btn"
            title="下移"
            aria-label="下移此内容"
            disabled={!canMoveDown}
            onClick={() => onMove(index, 1)}
          >
            <svg viewBox="0 0 16 16" width="13" height="13">
              <path d="m8 13.5-5-5.5h3V3h4v5h3Z" fill="currentColor" />
            </svg>
          </button>
          <button
            type="button"
            className="be-icon-btn danger"
            title="删除此内容"
            aria-label="删除此内容"
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
  switch (block.type) {
    case 'text':
      return <TextEditor block={block} onChange={change} />
    case 'image':
      return <ImageEditor block={block} onChange={change} onPreview={onPreview} />
    case 'table':
      return <TableEditor block={block} onChange={change} />
    case 'formula':
      return <FormulaEditor block={block} onChange={change} />
    case 'code':
      return <CodeEditor block={block} onChange={change} />
    case 'mermaid':
      return <MermaidEditor block={block} onChange={change} onPreview={onPreview} />
    case 'orderedList':
      return <ListEditor block={block} onChange={change} ordered />
    case 'unorderedList':
      return <ListEditor block={block} onChange={change} ordered={false} />
  }
}
