/**
 * 结构栏：文档树（默认全展开，可折叠/搜索/右键复制删除）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NodeDto } from '../../../../shared/project'
import { useApp } from '../../state/AppContext'
import { ChevronDownIcon, ChevronUpIcon, LevelsIcon } from '../icons'
import './tree.css'

interface MenuState {
  x: number
  y: number
  nodeId: string
}

/** 展开状态存在工程库的 ui_state 里，按工程各记一份 */
const EXPANDED_STATE_KEY = 'tree_expanded'

export default function TreePanel(): React.JSX.Element {
  const { session, selectedId, selectNode, copyNode, deleteNode } = useApp()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [levelMenu, setLevelMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const levelMenuRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  /** 搜索匹配集：一次遍历算清命中、要显示的祖先与第一个命中，避免逐行递归扫子树 */
  const needle = query.trim().toLowerCase()
  const match = useMemo(() => {
    const empty: TreeMatchIndex = { hits: new Set(), order: [], visible: new Set(), first: null }
    return session ? buildMatchIndex(session.root, needle) : empty
  }, [session, needle])

  const sessionKey = session?.info.dprojPath ?? ''

  /** 展开状态写回工程库；切工程时按新工程的记录恢复 */
  const persistExpanded = useCallback((next: Set<string>): void => {
    void window.documentor.uiState.save(EXPANDED_STATE_KEY, JSON.stringify([...next])).catch(() => undefined)
  }, [])

  useEffect(() => {
    setQuery('')
    if (!session) return
    let disposed = false
    const all = new Set<string>()
    collect(session.root, all)
    void window.documentor.uiState
      .load(EXPANDED_STATE_KEY)
      .then((raw) => {
        if (disposed) return
        // 没有记录就全展开；有记录（哪怕是空数组，表示用户全折了）就照它来
        setExpanded(parseExpanded(raw, all) ?? all)
      })
      .catch(() => {
        if (!disposed) setExpanded(all)
      })
    return () => {
      disposed = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey])

  /** 选中项滚入可视区：恢复上次选中或跳到别的章节时，用户得看得见选的是哪一个 */
  useEffect(() => {
    if (!selectedId) return
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-node-id="${selectedId}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, sessionKey])

  /** 搜索时滚到第一个命中，省得用户自己在一长串里找 */
  useEffect(() => {
    const target = match.first
    if (!target) return
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-node-id="${target}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [match])
  useEffect(() => {
    const close = (event: MouseEvent): void => {
      const target = event.target as Node
      if (menuRef.current && !menuRef.current.contains(target)) setMenu(null)
      if (levelMenuRef.current && !levelMenuRef.current.contains(target)) setLevelMenu(false)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setMenu(null)
        setLevelMenu(false)
      }
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key)
    }
  }, [])

  /** 层级菜单打开后把焦点放到第一项，键盘能接着走 */
  useEffect(() => {
    if (!levelMenu) return
    levelMenuRef.current?.querySelector<HTMLButtonElement>('.tree-level-menu button')?.focus()
  }, [levelMenu])

  const menuNode: NodeDto | null = useMemo(() => {
    if (!menu || !session) return null
    return findById(session.root, menu.nodeId)
  }, [menu, session])

  /** 菜单打开后：先把越界的部分收回来，再把焦点放到第一个可用项上（键盘能直接接着走） */
  useEffect(() => {
    const el = menuRef.current
    if (!menu || !el) return
    const rect = el.getBoundingClientRect()
    const overflowX = rect.right - window.innerWidth + 8
    const overflowY = rect.bottom - window.innerHeight + 8
    if (overflowX > 0 || overflowY > 0) {
      setMenu((prev) =>
        prev
          ? { ...prev, x: prev.x - Math.max(0, overflowX), y: prev.y - Math.max(0, overflowY) }
          : prev
      )
      return
    }
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [menu])

  /** 列表子标题在各自父节点下的次序：标签上的圆圈数字取这一段（与导出侧编号链同源） */
  const listIndex = useMemo(() => {
    const map = new Map<string, number>()
    if (session) assignListIndex(session.root, map)
    return map
  }, [session])

  /** 文档里最深的标题层级：按层级折叠的菜单项按它生成 */
  const maxLevel = useMemo(() => {
    if (!session) return 0
    let deepest = 0
    const walk = (node: NodeDto): void => {
      if (node.headingLevel > deepest) deepest = node.headingLevel
      for (const child of node.children) walk(child)
    }
    walk(session.root)
    return deepest
  }, [session])

  /** 当前看得见的行（前序），键盘上下移动按它走；同时带上父节点便于左键回退 */
  const flatRows = useMemo(() => {
    const empty = { rows: [] as NodeDto[], parentOf: new Map<string, string>() }
    return session ? flattenVisible(session.root, expanded, needle.length > 0, match) : empty
  }, [session, expanded, needle, match])

  const toggle = (id: string): void => {
    const next = new Set(expanded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setExpanded(next)
    persistExpanded(next)
  }

  /**
   * 树内键盘操作：上下移动选中，右键展开/进入子节点，左键折叠/回父节点，Home/End 到首尾。
   * 这个面板的选中项直接驱动右侧编辑区，所以方向键移动的就是选中项本身。
   *
   * 处理挂在面板上而不是树容器上：搜索完最顺手的动作是直接按↓走进结果，
   * 那时焦点还在搜索框里，挂在树容器上就收不到键事件。焦点在搜索框时只接管上下键，
   * 左右与 Home/End 留给文本光标。
   */
  const onTreeKeyDown = (event: React.KeyboardEvent): void => {
    const fromSearch = (event.target as HTMLElement).tagName === 'INPUT'
    if (fromSearch && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = flatRows.rows
    if (rows.length === 0) return
    const index = rows.findIndex((n) => n.id === selectedId)
    const current = index >= 0 ? rows[index] : undefined
    /** 根节点没有折叠箭头，键盘也不该把它整个收起来（要全折有工具栏按钮） */
    const collapsible = current !== undefined && flatRows.parentOf.has(current.id)
    const selectAt = (i: number): void => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, i))]
      if (target) selectNode(target.id)
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        selectAt(index + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        selectAt(index - 1)
        break
      case 'Home':
        event.preventDefault()
        selectAt(0)
        break
      case 'End':
        event.preventDefault()
        selectAt(rows.length - 1)
        break
      case 'ArrowRight':
        if (!current) break
        event.preventDefault()
        if (collapsible && current.children.length > 0 && !expanded.has(current.id)) toggle(current.id)
        else selectAt(index + 1)
        break
      case 'ArrowLeft': {
        if (!current) break
        event.preventDefault()
        if (collapsible && current.children.length > 0 && expanded.has(current.id)) {
          toggle(current.id)
        } else {
          const parentId = flatRows.parentOf.get(current.id)
          if (parentId) selectNode(parentId)
        }
        break
      }
      default:
        break
    }
  }

  if (!session) return <aside className="tree-panel" />

  const root = session.root
  const searching = needle.length > 0

  const expandAll = (): void => {
    const next = new Set<string>()
    collect(root, next)
    setExpanded(next)
    persistExpanded(next)
  }

  const collapseAll = (): void => {
    const next = new Set<string>()
    setExpanded(next)
    persistExpanded(next)
  }

  /** 收起某一支的全部后代（箭头按住 Alt 点击）：长文档里逐级点太慢 */
  const collapseBranch = (id: string): void => {
    const branch = findById(root, id)
    if (!branch) return
    const doomed = new Set<string>()
    for (const child of branch.children) collect(child, doomed)
    const next = new Set([...expanded].filter((x) => !doomed.has(x)))
    setExpanded(next)
    persistExpanded(next)
  }

  /**
   * 折到第 level 级：1 到 level 级照常显示，更深的收起。
   * 语义与「全部折叠」一致——全部折叠就是折到 1 级。
   */
  const collapseToLevel = (level: number): void => {
    const next = new Set<string>()
    const walk = (node: NodeDto): void => {
      if (node.id !== root.id && node.headingLevel < level) next.add(node.id)
      for (const child of node.children) walk(child)
    }
    walk(root)
    setExpanded(next)
    persistExpanded(next)
  }

  /** 在上一个/下一个命中之间切换，到头回绕；一个都没选过就从第一个（或最后一个）开始 */
  const stepHit = (delta: 1 | -1): void => {
    const hits = match.order
    if (hits.length === 0) return
    const at = selectedId ? hits.indexOf(selectedId) : -1
    const index = at < 0 ? (delta > 0 ? 0 : hits.length - 1) : (at + delta + hits.length) % hits.length
    const target = hits[index]
    if (target) selectNode(target)
  }

  // 右键菜单：打开时聚焦第一个可用项，越界就往回收，禁用项说明为什么不能点
  const canCopy = !!menuNode && menuNode.headingLevel > 0 && menuNode.copyable
  const canDelete = !!menuNode && menuNode.headingLevel > 0 && menuNode.deletable
  const copyDeniedReason = !menuNode
    ? ''
    : menuNode.headingLevel === 0
      ? '根节点不能复制'
      : '模板未开放复制'
  const deleteDeniedReason = !menuNode
    ? ''
    : menuNode.headingLevel === 0
      ? '根节点不能删除'
      : '模板未开放删除'

  const onMenuKeyDown = (event: React.KeyboardEvent): void => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    if (items.length === 0) return
    const index = items.findIndex((el) => el === document.activeElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(index + 1 + items.length) % items.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(index - 1 + items.length) % items.length]?.focus()
    }
  }

  return (
    <aside className="tree-panel" onKeyDown={onTreeKeyDown}>
      <div className="tree-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索章节…"
          aria-label="搜索章节"
        />
        {searching && match.hits.size > 0 && (
          <>
            <span className="tree-count" aria-live="polite">
              {match.hits.size} 项
            </span>
            <button
              type="button"
              className="tree-icon-btn"
              onClick={() => stepHit(-1)}
              title="上一个命中"
              aria-label="上一个命中"
            >
              <ChevronUpIcon size={14} />
            </button>
            <button
              type="button"
              className="tree-icon-btn"
              onClick={() => stepHit(1)}
              title="下一个命中"
              aria-label="下一个命中"
            >
              <ChevronDownIcon size={14} />
            </button>
          </>
        )}
        {searching && match.hits.size === 0 && (
          <span className="tree-count" aria-live="polite">
            0 项
          </span>
        )}
        <div className="tree-level-fold" ref={levelMenuRef}>
          <button
            type="button"
            className="tree-icon-btn"
            onClick={() => setLevelMenu((open) => !open)}
            title="展开与折叠"
            aria-label="展开与折叠"
            aria-haspopup="menu"
            aria-expanded={levelMenu}
          >
            <LevelsIcon size={14} />
          </button>
          {levelMenu && (
            <div className="tree-level-menu" role="menu" aria-label="展开与折叠">
              <button
                role="menuitem"
                onClick={() => {
                  expandAll()
                  setLevelMenu(false)
                }}
              >
                全部展开
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  collapseAll()
                  setLevelMenu(false)
                }}
              >
                全部折叠
              </button>
              {Array.from({ length: Math.max(0, maxLevel - 1) }, (_, i) => i + 2).map((level) => (
                <button
                  key={level}
                  role="menuitem"
                  onClick={() => {
                    collapseToLevel(level)
                    setLevelMenu(false)
                  }}
                >
                  折到 {level} 级
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div
        className="tree-scroll"
        ref={scrollRef}
        role="tree"
        aria-label="文档结构"
        tabIndex={0}
        aria-activedescendant={selectedId ? treeRowDomId(selectedId) : undefined}
        // 点树区就把焦点收进容器：否则方向键落在别处，键事件根本到不了处理函数。
        // 这里连同默认聚焦一起拦掉，免得行里的箭头按钮把焦点从容器抢走。
        onMouseDown={(e) => {
          e.preventDefault()
          scrollRef.current?.focus()
        }}
      >
        <div
          className={`tree-root-row${selectedId === root.id ? ' is-selected' : ''}`}
          id={treeRowDomId(root.id)}
          role="treeitem"
          aria-level={1}
          aria-selected={selectedId === root.id}
          onClick={() => selectNode(root.id)}
        >
          <span className="tree-caret tree-caret-empty" />
          <span className="tree-badge tree-badge-root">根</span>
          <span className="tree-title">{root.title || '(未命名文档)'}</span>
        </div>
        {root.children.map((child, i) => (
          <TreeNodeRow
            key={child.id}
            node={child}
            depth={0}
            posInSet={i + 1}
            setSize={root.children.length}
            needle={needle}
            match={match}
            expanded={expanded}
            selectedId={selectedId}
            listIndex={listIndex}
            onToggle={toggle}
            onCollapseBranch={collapseBranch}
            onSelect={selectNode}
            onContextMenu={(e, nodeId) => {
              e.preventDefault()
              // 右键同时把该行选上：菜单里的操作对象与右侧编辑区看到的保持一致
              selectNode(nodeId)
              setMenu({ x: e.clientX, y: e.clientY, nodeId })
            }}
          />
        ))}
        {root.children.length === 0 && <div className="tree-empty">模板里还没有章节</div>}
        {root.children.length > 0 && searching && match.hits.size === 0 && (
          <div className="tree-empty">没有匹配的章节</div>
        )}
      </div>

      {menu && menuNode && (
        <div
          ref={menuRef}
          className="tree-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          aria-label="章节操作"
          onKeyDown={onMenuKeyDown}
        >
          <div className="tree-menu-head" title={rowTooltip(menuNode)}>
            {menuNode.title || '·'}
          </div>
          <button
            role="menuitem"
            disabled={!canCopy}
            title={canCopy ? '复制该章节及其子章节' : copyDeniedReason}
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
            disabled={!canDelete}
            title={canDelete ? '删除该章节及其子章节' : deleteDeniedReason}
            onClick={() => {
              void deleteNode(menuNode.id)
              setMenu(null)
            }}
          >
            删除章节
          </button>
          <button
            role="menuitem"
            disabled={menuNode.children.length === 0}
            title={menuNode.children.length === 0 ? '该章节没有子章节' : '收起该章节下的所有层级'}
            onClick={() => {
              collapseBranch(menuNode.id)
              setMenu(null)
            }}
          >
            折叠该分支
          </button>
        </div>
      )}
    </aside>
  )
}

function TreeNodeRow(props: {
  node: NodeDto
  depth: number
  posInSet: number
  setSize: number
  needle: string
  match: TreeMatchIndex
  expanded: Set<string>
  selectedId: string | null
  listIndex: Map<string, number>
  onToggle: (id: string) => void
  onCollapseBranch: (id: string) => void
  onSelect: (id: string) => void
  onContextMenu: (e: React.MouseEvent, nodeId: string) => void
}): React.JSX.Element {
  const { node, depth, posInSet, setSize, needle, match, expanded, selectedId, listIndex, onToggle, onCollapseBranch, onSelect, onContextMenu } = props
  const hasChildren = node.children.length > 0
  const isOpen = expanded.has(node.id)
  const searching = needle.length > 0

  if (searching && !match.visible.has(node.id)) return <></>

  const visibleChildren = searching ? node.children : isOpen ? node.children : []
  const matchedTitle = searching && match.hits.has(node.id)

  return (
    <>
      <div
        className={`tree-row${selectedId === node.id ? ' is-selected' : ''}`}
        id={treeRowDomId(node.id)}
        data-node-id={node.id}
        role="treeitem"
        aria-level={depth + 2}
        aria-selected={selectedId === node.id}
        aria-expanded={hasChildren ? isOpen : undefined}
        aria-posinset={posInSet}
        aria-setsize={setSize}
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
            title={isOpen ? '折叠；按住 Alt 点击收起整枝' : '展开；按住 Alt 点击收起整枝'}
            onClick={(e) => {
              e.stopPropagation()
              if (e.altKey) onCollapseBranch(node.id)
              else onToggle(node.id)
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
            title={`列表子标题，第 ${node.headingLevel} 级`}
          >
            {circled(listIndex.get(node.id) ?? 1)}
          </span>
        ) : (
          <span className="tree-badge tree-badge-level" title={`第 ${node.headingLevel} 级标题`}>
            {node.headingLevel}
          </span>
        )}
        <span className={`tree-title${matchedTitle ? ' match' : ''}`}>
          {searching ? highlight(node.title || '·', needle) : node.title || '·'}
        </span>
      </div>
      {visibleChildren.map((child, i) => (
        <TreeNodeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          posInSet={i + 1}
          setSize={visibleChildren.length}
          needle={needle}
          match={match}
          expanded={expanded}
          selectedId={selectedId}
          listIndex={listIndex}
          onToggle={onToggle}
          onCollapseBranch={onCollapseBranch}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  )
}

/** 行在 DOM 里的 id：键盘导航靠 aria-activedescendant 指过来 */
function treeRowDomId(nodeId: string): string {
  return `tree-node-${nodeId}`
}

/**
 * 解析存下来的展开状态。
 * 没有记录返回 null（调用方用全展开兜底）；空数组是有效记录，表示用户全折了。
 * 工程里已不存在的 id 直接丢掉，避免模板换过之后留下幽灵状态。
 */
function parseExpanded(raw: string, valid: Set<string>): Set<string> | null {
  if (raw.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return new Set(parsed.filter((x): x is string => typeof x === 'string' && valid.has(x)))
  } catch {
    return null
  }
}

/**
 * 摊平当前看得见的行（前序），供键盘导航按显示顺序走。
 * 顺带记下每个节点的父节点，左键回退时要用。
 */
function flattenVisible(
  root: NodeDto,
  expanded: Set<string>,
  searching: boolean,
  match: TreeMatchIndex
): { rows: NodeDto[]; parentOf: Map<string, string> } {
  const rows: NodeDto[] = []
  const parentOf = new Map<string, string>()
  // 搜索时根节点不进导航序列：按↓的意图是走进结果，不是跳到根上
  if (!searching) rows.push(root)
  const walk = (node: NodeDto, parentId: string): void => {
    if (searching && !match.visible.has(node.id)) return
    rows.push(node)
    parentOf.set(node.id, parentId)
    const kids = searching ? node.children : expanded.has(node.id) ? node.children : []
    for (const child of kids) walk(child, node.id)
  }
  for (const child of root.children) walk(child, root.id)
  return { rows, parentOf }
}

/** 给每个列表子标题标记它在父节点下的第几项（1 起） */
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

interface TreeMatchIndex {
  /** 标题命中的节点 */
  hits: Set<string>
  /** 命中节点按前序排好，供上一个/下一个命中切换 */
  order: string[]
  /** 需要渲染的节点：命中项加上它们的祖先 */
  visible: Set<string>
  /** 前序第一个命中，供自动滚过去用 */
  first: string | null
}

/**
 * 一次前序遍历算清匹配集。
 * 以前是每行各自递归扫一遍子树判断"后代有没有命中"，最坏 O(n²)；
 * 键入时每敲一个字都要重算，大树会拖手。
 */
function buildMatchIndex(root: NodeDto, needle: string): TreeMatchIndex {
  const hits = new Set<string>()
  const order: string[] = []
  const visible = new Set<string>()
  if (needle.length === 0) return { hits, order, visible, first: null }

  let first: string | null = null
  const walk = (node: NodeDto): boolean => {
    const selfHit = node.title.toLowerCase().includes(needle)
    if (selfHit) {
      hits.add(node.id)
      order.push(node.id)
      if (first === null) first = node.id
    }
    let childHit = false
    for (const child of node.children) {
      if (walk(child)) childHit = true
    }
    if (selfHit || childHit) visible.add(node.id)
    return selfHit || childHit
  }
  walk(root)
  return { hits, order, visible, first }
}

/** 命中子串高亮；needle 必须已 trim 并转小写 */
function highlight(text: string, needle: string): React.ReactNode {
  const lower = text.toLowerCase()
  const parts: React.ReactNode[] = []
  let from = 0
  let at = lower.indexOf(needle)
  let key = 0
  while (at >= 0) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(
      <mark className="tree-hl" key={key}>
        {text.slice(at, at + needle.length)}
      </mark>
    )
    key += 1
    from = at + needle.length
    at = lower.indexOf(needle, from)
  }
  if (parts.length === 0) return text
  if (from < text.length) parts.push(text.slice(from))
  return parts
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
