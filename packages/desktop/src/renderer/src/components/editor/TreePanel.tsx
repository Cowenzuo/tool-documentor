/**
 * 结构栏：文档树（默认全展开，可折叠/搜索/右键复制删除）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { NodeDto } from '../../../../shared/project'
import { useApp } from '../../state/AppContext'
import './tree.css'

interface MenuState {
  x: number
  y: number
  nodeId: string
}

export default function TreePanel(): React.JSX.Element {
  const { session, selectedId, selectNode, copyNode, deleteNode } = useApp()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const sessionKey = session?.info.dprojPath ?? ''
  useEffect(() => {
    // 打开工程后全部展开
    if (session) {
      const all = new Set<string>()
      collect(session.root, all)
      setExpanded(all)
    }
    setQuery('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey])

  /** 选中项滚入可视区：恢复上次选中或跳到别的章节时，用户得看得见选的是哪一个 */
  useEffect(() => {
    if (!selectedId) return
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-node-id="${selectedId}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, sessionKey])

  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenu(null)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key)
    }
  }, [])

  const menuNode: NodeDto | null = useMemo(() => {
    if (!menu || !session) return null
    return findById(session.root, menu.nodeId)
  }, [menu, session])

  /** 子标题在各自父节点下的次序：标签上的圆圈数字取这一段（与导出侧编号链同源） */
  const listIndex = useMemo(() => {
    const map = new Map<string, number>()
    if (session) assignListIndex(session.root, map)
    return map
  }, [session])

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (!session) return <aside className="tree-panel" />

  const root = session.root

  return (
    <aside className="tree-panel">
      <div className="tree-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索章节…"
          aria-label="搜索章节"
        />
      </div>
      <div className="tree-scroll" ref={scrollRef}>
        <div className="tree-root-row" onClick={() => selectNode(root.id)}>
          <span className="tree-caret tree-caret-empty" />
          <span className="tree-badge tree-badge-root">根</span>
          <span className={`tree-title${selectedId === root.id ? ' selected' : ''}`}>
            {root.title || '(未命名文档)'}
          </span>
        </div>
        {root.children.map((child) => (
          <TreeNodeRow
            key={child.id}
            node={child}
            depth={0}
            query={query}
            expanded={expanded}
            selectedId={selectedId}
            listIndex={listIndex}
            onToggle={toggle}
            onSelect={selectNode}
            onContextMenu={(e, nodeId) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, nodeId })
            }}
          />
        ))}
        {root.children.length === 0 && <div className="tree-empty">模板里还没有章节</div>}
      </div>

      {menu && menuNode && (
        <div
          ref={menuRef}
          className="tree-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
        >
          <button
            role="menuitem"
            disabled={menuNode.headingLevel === 0 || !menuNode.copyable}
            onClick={() => {
              void copyNode(menuNode.id)
              setMenu(null)
            }}
          >
            复制章节
          </button>
          <button
            role="menuitem"
            className="danger"
            disabled={menuNode.headingLevel === 0 || !menuNode.deletable}
            onClick={() => {
              void deleteNode(menuNode.id)
              setMenu(null)
            }}
          >
            删除章节
          </button>
        </div>
      )}
    </aside>
  )
}

function TreeNodeRow(props: {
  node: NodeDto
  depth: number
  query: string
  expanded: Set<string>
  selectedId: string | null
  listIndex: Map<string, number>
  onToggle: (id: string) => void
  onSelect: (id: string) => void
  onContextMenu: (e: React.MouseEvent, nodeId: string) => void
}): React.JSX.Element {
  const { node, depth, query, expanded, selectedId, listIndex, onToggle, onSelect, onContextMenu } = props
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.id)
  const queryTrim = query.trim().toLowerCase()
  const selfMatch = queryTrim.length === 0 || node.title.toLowerCase().includes(queryTrim)
  const childMatch = (n: NodeDto): boolean =>
    n.title.toLowerCase().includes(queryTrim) || n.children.some(childMatch)

  const showSelf = queryTrim.length === 0 || selfMatch || node.children.some(childMatch)
  if (!showSelf) return <></>

  const visibleChildren = queryTrim.length === 0 ? (isOpen ? node.children : []) : node.children
  const matchedTitle = queryTrim.length > 0 && selfMatch

  return (
    <>
      <div
        className={`tree-row${selectedId === node.id ? ' is-selected' : ''}`}
        data-node-id={node.id}
        style={{ paddingLeft: 8 + depth * 16 }}
        onClick={() => onSelect(node.id)}
        onContextMenu={(e) => onContextMenu(e, node.id)}
        title={rowTooltip(node)}
      >
        {hasChildren ? (
          <button
            type="button"
            className="tree-caret"
            aria-label={isOpen ? '折叠' : '展开'}
            onClick={(e) => {
              e.stopPropagation()
              onToggle(node.id)
            }}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" className={isOpen ? 'open' : ''}>
              <path d="M5 3.5 10.5 8 5 12.5Z" fill="currentColor" />
            </svg>
          </button>
        ) : (
          <span className="tree-caret tree-caret-empty" />
        )}
        {node.isSubTitle ? (
          <span
            className={`tree-badge tree-badge-list lv${levelClass(node.headingLevel)}`}
            title={`子标题，第 ${node.headingLevel} 级`}
          >
            {circled(listIndex.get(node.id) ?? 1)}
          </span>
        ) : (
          <span className="tree-badge tree-badge-level" title={`第 ${node.headingLevel} 级标题`}>
            {node.headingLevel}
          </span>
        )}
        <span className={`tree-title${matchedTitle ? ' match' : ''}`}>{node.title || '·'}</span>
      </div>
      {visibleChildren.map((child) => (
        <TreeNodeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          query={query}
          expanded={expanded}
          selectedId={selectedId}
          listIndex={listIndex}
          onToggle={onToggle}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  )
}

/** 给每个子标题标记它在父节点下的第几项（1 起） */
function assignListIndex(node: NodeDto, out: Map<string, number>): void {
  let index = 0
  for (const child of node.children) {
    if (child.isSubTitle) {
      index += 1
      out.set(child.id, index)
    }
    assignListIndex(child, out)
  }
}

/** 1..20 用圆圈数字，超出退回半角括号数字（模板层级不会这么多） */
function circled(value: number): string {
  return value >= 1 && value <= 20 ? String.fromCodePoint(0x2460 + value - 1) : `(${value})`
}

/**
 * 行悬停提示：标题被省略号截断时，这里能读全。
 * 以前只放描述，等于把"看不到的标题"换成"看得见的描述"，标题本身反而永远读不全。
 */
function rowTooltip(node: NodeDto): string {
  const title = node.title || '·'
  return node.description ? `${title}\n${node.description}` : title
}

/** 层级取色只用五档，超过第五级沿用第五档 */
function levelClass(level: number): number {
  return Math.min(5, Math.max(1, level))
}

function collect(node: NodeDto, out: Set<string>): void {
  out.add(node.id)
  for (const child of node.children) collect(child, out)
}

function findById(node: NodeDto, id: string): NodeDto | null {
  if (node.id === id) return node
  for (const child of node.children) {
    const hit = findById(child, id)
    if (hit) return hit
  }
  return null
}
