/**
 * 中栏：结构模板的节点树（递归列表，可展开收起、可选中；不做拖拽）。
 * 视觉语言沿用编辑器的树：层级数字、需要时才有的一枚类型标记、问题圆点；
 * 状态由外面给（选中路径 + 展开集合），组件本身无状态。
 *
 * 节点的结构操作（加子节点/加同级/复制/上移/下移/删除/开合这一支）都在**右键菜单**里，
 * 与主编辑器的章节树同一套语言：右键同时把该行选上，按不了的项目写明原因。
 * 行上不挂按钮——一行本来就只有二十来个字，挤上五个按钮标题就得让位。
 */
import { useEffect, useRef, type JSX } from 'react'
import type { TemplateIssueDto } from '../../../../shared/project'
import { ChevronDownIcon } from '../icons'
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu'
import { CollapseAllIcon, ExpandAllIcon } from './icons'
import {
  asObject,
  branchKeys,
  hasChildren,
  headingLevel,
  nodeAt,
  nodeJsonPath,
  nodeKind,
  nodeTitle,
  nodeTypeBadge,
  pathKey,
  rawBlocks,
  rawChildren,
  rootNode,
  type NodePath,
  type TemplateDoc,
  type TemplateObject
} from './templateDoc'
import { countIssues, issuesUnder } from './templateValidate'
import type { TemplateEditorStatus } from './useTemplateEditor'

interface NodeTreeProps {
  doc: TemplateDoc | null
  status: TemplateEditorStatus
  selectedPath: NodePath
  expanded: Set<string>
  issues: TemplateIssueDto[]
  onSelect: (path: NodePath) => void
  onToggle: (key: string) => void
  onExpandAll: () => void
  onCollapseAll: () => void
  onAddChild: (path: NodePath) => void
  onAddSibling: (path: NodePath) => void
  onDuplicate: (path: NodePath) => void
  onMove: (path: NodePath, delta: -1 | 1) => void
  onRemove: (path: NodePath) => void
  onToggleBranch: (path: NodePath) => void
}

function IssueDot({ issues }: { issues: TemplateIssueDto[] }): JSX.Element | null {
  const { errors, warnings } = countIssues(issues)
  if (errors > 0) return <span className="tpl-dot tpl-dot-error" title={`${errors} 个错误`} />
  if (warnings > 0) return <span className="tpl-dot tpl-dot-warn" title={`${warnings} 处提示`} />
  return null
}

/** 1..20 用圆圈数字，超出退回半角括号数字（与结构栏同一套写法） */
function circled(value: number): string {
  const n = value >= 1 ? value : 1
  return n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : `(${n})`
}

/** 列表子标题的取色只用五档，超过第五级沿用第五档（与结构栏一致） */
function levelClass(level: number): number {
  return Math.min(5, Math.max(1, level))
}

function Row({
  node,
  path,
  depth,
  listIndex,
  selectedPath,
  expanded,
  issues,
  onSelect,
  onToggle,
  onOpenMenu
}: {
  node: TemplateObject
  path: NodePath
  depth: number
  /** 列表子标题在同一个父节点下排第几项（1 起）：圆圈数字用它，与结构栏一个口径 */
  listIndex: number
  selectedPath: NodePath
  expanded: Set<string>
  issues: TemplateIssueDto[]
  onSelect: (path: NodePath) => void
  onToggle: (key: string) => void
  onOpenMenu: (path: NodePath, x: number, y: number) => void
}): JSX.Element {
  const key = pathKey(path)
  const isRoot = path.length === 0
  const hasChild = hasChildren(node)
  /** 根节点常开：它的展开状态不接受操作，也不显示开合按钮 */
  const canToggle = hasChild && !isRoot
  const open = isRoot || expanded.has(key)
  const selected = pathKey(selectedPath) === key
  const blocks = rawBlocks(node).length
  const kind = nodeKind(node)
  const level = headingLevel(node)
  const typeBadge = nodeTypeBadge(node)
  const under = issuesUnder(issues, nodeJsonPath(path))

  return (
    <div>
      <div
        className={`tpl-tree-row${isRoot ? ' is-root' : ''}${selected ? ' is-selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        data-path={key}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={canToggle ? open : undefined}
        tabIndex={0}
        // 中栏是窄栏，长标题会被省略号截掉，鼠标停在行上能看到全名
        title={nodeTitle(node) || '（未命名）'}
        onClick={() => onSelect(path)}
        onContextMenu={(event) => {
          event.preventDefault()
          // 右键同时把该行选上：菜单里的操作对象与右栏看到的保持一致
          onSelect(path)
          onOpenMenu(path, event.clientX, event.clientY)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect(path)
            return
          }
          // 键盘也要能开这单（Windows 的习惯键：Shift+F10 或菜单键）
          if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault()
            const rect = event.currentTarget.getBoundingClientRect()
            onSelect(path)
            onOpenMenu(path, Math.round(rect.left + 24), Math.round(rect.bottom))
          }
        }}
      >
        {canToggle ? (
          <button
            type="button"
            className="tpl-tree-caret"
            aria-label={open ? '收起' : '展开'}
            onClick={(event) => {
              event.stopPropagation()
              onToggle(key)
            }}
          >
            <ChevronDownIcon size={13} className={open ? 'open' : ''} />
          </button>
        ) : (
          <span className="tpl-tree-caret" aria-hidden="true" />
        )}
        {/* 层级标记与常规文档编辑的结构栏同一套：
            根=品牌色块、层级标题=素色数字、列表子标题=带色圆圈数字（同级里第几项） */}
        {isRoot ? (
          <span className="tpl-tree-badge tpl-tree-badge-root" title="根节点：整篇文档">
            根
          </span>
        ) : kind === 'listSubTitle' ? (
          <span className={`tpl-tree-badge tpl-tree-badge-list lv${levelClass(level)}`} title={`列表子标题 · 本层第 ${listIndex} 个`}>
            {circled(listIndex)}
          </span>
        ) : (
          <span className="tpl-tree-badge tpl-tree-badge-level" title={`第 ${level} 级标题`}>
            {level}
          </span>
        )}
        <span className="tpl-tree-title">{nodeTitle(node) || '（未命名）'}</span>
        {/* 类型只在"结构栏那一套标记说不清"时占位置（认不出的取值） */}
        {typeBadge !== null && <span className="tpl-tree-type">{typeBadge}</span>}
        {blocks > 0 && <span className="tpl-tree-count">{blocks} 块</span>}
        <IssueDot issues={under} />
      </div>
      {hasChild && open && childRows()}
    </div>
  )

  /** 子行：列表子标题在同级里的序号与结构栏一样，按每个父节点各自数（1 起） */
  function childRows(): Array<JSX.Element | null> {
    let subTitleIndex = 0
    return rawChildren(node).map((raw, childIndex) => {
      const child = asObject(raw)
      if (!child) return null
      const isSubTitle = nodeKind(child) === 'listSubTitle'
      if (isSubTitle) subTitleIndex += 1
      return (
        <Row
          key={`${key}.${childIndex}`}
          node={child}
          path={[...path, childIndex]}
          depth={depth + 1}
          listIndex={isSubTitle ? subTitleIndex : 0}
          selectedPath={selectedPath}
          expanded={expanded}
          issues={issues}
          onSelect={onSelect}
          onToggle={onToggle}
          onOpenMenu={onOpenMenu}
        />
      )
    })
  }
}

export function NodeTree(props: NodeTreeProps): JSX.Element {
  const { doc, status, selectedPath, expanded, issues, onSelect, onToggle } = props
  const root = rootNode(doc)
  const selectedKey = pathKey(selectedPath)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const menu = useContextMenu<{ path: NodePath }>()

  /**
   * 选中项滚入可视区：新加的节点、树上点选都得看得见。
   * 依赖里不放 doc——编辑字段时 doc 每敲一下都换，会跟着做无用的滚动查询。
   */
  useEffect(() => {
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-path="${selectedKey}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selectedKey, expanded])

  /** 菜单的行为（贴边收回、点别处/Esc 收起、方向键走项）与共用外观见 ContextMenu */

  const menuPath = menu.payload ? menu.payload.path : null
  const menuNode = menuPath ? nodeAt(doc, menuPath) : null
  const menuIsRoot = menuPath !== null && menuPath.length === 0
  const menuIndex = menuPath ? (menuPath[menuPath.length - 1] ?? 0) : 0
  const menuParent = menuPath ? nodeAt(doc, menuPath.slice(0, -1)) : null
  const menuSiblingCount = menuParent ? rawChildren(menuParent).length : 0
  const menuName = menuNode ? nodeTitle(menuNode) || '（未命名）' : ''
  const menuBranch = menuPath ? branchKeys(doc, menuPath) : []
  /**
   * 这一支现在是开的还是收的：根节点永远画成展开的，所以它按"下面各层开没开"算，
   * 其余节点就是它自己开没开（点一下连下面几层一起收/一起开）。
   */
  const menuBranchOpen = menuIsRoot
    ? menuBranch.filter((key) => key !== '').every((key) => expanded.has(key))
    : expanded.has(pathKey(menuPath ?? []))

  const items: MenuItem[] = menuPath === null || menuNode === null
    ? []
    : [
        {
          label: '添加子节点',
          disabled: false,
          run: () => props.onAddChild(menuPath)
        },
        {
          label: '添加同级',
          title: menuIsRoot ? '根节点无同级' : undefined,
          disabled: menuIsRoot,
          run: () => props.onAddSibling(menuPath)
        },
        {
          label: '复制节点',
          title: menuIsRoot ? '根节点不可复制' : undefined,
          disabled: menuIsRoot,
          run: () => props.onDuplicate(menuPath)
        },
        {
          label: '上移',
          title: menuIsRoot ? '根节点不可移动' : menuIndex > 0 ? undefined : '已是第一个',
          disabled: menuIsRoot || menuIndex === 0,
          run: () => props.onMove(menuPath, -1)
        },
        {
          label: '下移',
          title:
            menuIsRoot
              ? '根节点不可移动'
              : menuIndex < menuSiblingCount - 1
                ? undefined
                : '已是最后一个',
          disabled: menuIsRoot || menuIndex >= menuSiblingCount - 1,
          run: () => props.onMove(menuPath, 1)
        },
        {
          label: '删除节点',
          title: menuIsRoot ? '根节点不可删除' : undefined,
          disabled: menuIsRoot,
          danger: true,
          run: () => props.onRemove(menuPath)
        },
        {
          label: menuBranchOpen ? '折叠该分支' : '展开该分支',
          title: menuBranch.length === 0 ? '无子节点' : undefined,
          disabled: menuBranch.length === 0,
          run: () => props.onToggleBranch(menuPath)
        }
      ]

  return (
    <section className="tpl-col tpl-col-tree" aria-label="节点树">
      <header className="tpl-col-head">
        <h2>节点树</h2>
        {/* 节点的增删移都在行的右键菜单里；栏头只留"整棵树"的开合 */}
        <div className="tpl-col-tools">
          <button
            type="button"
            className="tpl-icon-btn"
            onClick={props.onExpandAll}
            disabled={!root}
            title="全部展开"
            aria-label="全部展开"
          >
            <ExpandAllIcon />
          </button>
          <button
            type="button"
            className="tpl-icon-btn"
            onClick={props.onCollapseAll}
            disabled={!root}
            title="全部折叠"
            aria-label="全部折叠"
          >
            <CollapseAllIcon />
          </button>
        </div>
      </header>
      <div className="tpl-col-body" ref={scrollRef} role="tree" aria-label="节点">
        {!root ? (
          <p className="tpl-empty">
            {status === 'ready' ? '还没有打开结构模板' : '正在读取模板目录…'}
          </p>
        ) : (
          <Row
            node={root}
            path={[]}
            depth={0}
            listIndex={0}
            selectedPath={selectedPath}
            expanded={expanded}
            issues={issues}
            onSelect={onSelect}
            onToggle={onToggle}
            onOpenMenu={(path, x, y) => menu.openIn({ path }, x, y)}
          />
        )}
      </div>
      {menuNode && (
        <ContextMenu
          control={menu}
          className="tpl-tree-menu"
          label="节点操作"
          head={menuName}
          headTitle={menuPath ? nodeJsonPath(menuPath) : undefined}
          items={items}
        />
      )}
    </section>
  )
}

export default NodeTree
