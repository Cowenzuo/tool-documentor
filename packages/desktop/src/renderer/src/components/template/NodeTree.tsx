/**
 * 中栏：结构模板的节点树（递归列表，可展开收起、可选中；不做拖拽）。
 * 视觉语言沿用编辑器的树：层级数字、需要时才有的一枚类型标记、问题圆点；
 * 状态由外面给（选中路径 + 展开集合），组件本身无状态。
 */
import { useEffect, useRef, type JSX } from 'react'
import type { TemplateIssueDto } from '../../../../shared/project'
import { ChevronDownIcon } from '../icons'
import { AddChildIcon, AddSiblingIcon, CollapseAllIcon, ExpandAllIcon, MoveDownIcon, MoveUpIcon, TrashIcon } from './icons'
import {
  asObject,
  hasChildren,
  headingLevel,
  nodeJsonPath,
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
  /** 结构操作按"点的是哪一行"办事，所以都带 path */
  onAddChild: (path: NodePath) => void
  onAddSibling: (path: NodePath) => void
  onMove: (path: NodePath, delta: -1 | 1) => void
  onRemove: (path: NodePath) => void
}

function IssueDot({ issues }: { issues: TemplateIssueDto[] }): JSX.Element | null {
  const { errors, warnings } = countIssues(issues)
  if (errors > 0) return <span className="tpl-dot tpl-dot-error" title={`${errors} 个错误`} />
  if (warnings > 0) return <span className="tpl-dot tpl-dot-warn" title={`${warnings} 处提示`} />
  return null
}

function Row({
  node,
  path,
  depth,
  index,
  siblingCount,
  selectedPath,
  expanded,
  issues,
  onSelect,
  onToggle,
  onAddChild,
  onAddSibling,
  onMove,
  onRemove
}: {
  node: TemplateObject
  path: NodePath
  depth: number
  /** 在父节点里的次序与同层节点数：决定上移/下移/加同级能不能用 */
  index: number
  siblingCount: number
  selectedPath: NodePath
  expanded: Set<string>
  issues: TemplateIssueDto[]
  onSelect: (path: NodePath) => void
  onToggle: (key: string) => void
  onAddChild: (path: NodePath) => void
  onAddSibling: (path: NodePath) => void
  onMove: (path: NodePath, delta: -1 | 1) => void
  onRemove: (path: NodePath) => void
}): JSX.Element {
  const key = pathKey(path)
  const isRoot = path.length === 0
  const hasChild = hasChildren(node)
  /** 根节点常开：它的展开状态不接受操作，也不显示开合按钮 */
  const canToggle = hasChild && !isRoot
  const open = isRoot || expanded.has(key)
  const selected = pathKey(selectedPath) === key
  const blocks = rawBlocks(node).length
  const typeBadge = nodeTypeBadge(node)
  const under = issuesUnder(issues, nodeJsonPath(path))
  const canMoveUp = !isRoot && index > 0
  const canMoveDown = !isRoot && index < siblingCount - 1

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
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect(path)
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
        <span className="tpl-tree-level">{isRoot ? '根' : headingLevel(node)}</span>
        <span className="tpl-tree-title">{nodeTitle(node) || '（未命名）'}</span>
        {/* 类型只在"和普通节点不一样"时占位置（可复制组 / 副标题 / 认不出的取值） */}
        {typeBadge !== null && <span className="tpl-tree-type">{typeBadge}</span>}
        {blocks > 0 && <span className="tpl-tree-count">{blocks} 块</span>}
        <IssueDot issues={under} />
        {/* 结构操作在这一行上：悬停或选中时右侧浮出，点的是这一行的节点 */}
        <span className="tpl-tree-actions">
          <button
            type="button"
            className="tpl-icon-btn"
            title="在它下面加一个子节点"
            aria-label="添加子节点"
            onClick={(event) => {
              event.stopPropagation()
              onAddChild(path)
            }}
          >
            <AddChildIcon size={12} />
          </button>
          <button
            type="button"
            className="tpl-icon-btn"
            title={isRoot ? '根节点没有同级' : '在它后面加一个同级节点'}
            aria-label="添加同级"
            disabled={isRoot}
            onClick={(event) => {
              event.stopPropagation()
              onAddSibling(path)
            }}
          >
            <AddSiblingIcon size={12} />
          </button>
          <button
            type="button"
            className="tpl-icon-btn"
            title={isRoot ? '根节点不能移动' : canMoveUp ? '上移' : '已经是第一个'}
            aria-label="上移"
            disabled={!canMoveUp}
            onClick={(event) => {
              event.stopPropagation()
              onMove(path, -1)
            }}
          >
            <MoveUpIcon size={12} />
          </button>
          <button
            type="button"
            className="tpl-icon-btn"
            title={isRoot ? '根节点不能移动' : canMoveDown ? '下移' : '已经是最后一个'}
            aria-label="下移"
            disabled={!canMoveDown}
            onClick={(event) => {
              event.stopPropagation()
              onMove(path, 1)
            }}
          >
            <MoveDownIcon size={12} />
          </button>
          <button
            type="button"
            className="tpl-icon-btn tpl-danger"
            title={isRoot ? '根节点不能删除' : '删除该节点及其子节点'}
            aria-label="删除节点"
            disabled={isRoot}
            onClick={(event) => {
              event.stopPropagation()
              onRemove(path)
            }}
          >
            <TrashIcon size={12} />
          </button>
        </span>
      </div>
      {hasChild &&
        open &&
        rawChildren(node).map((raw, childIndex) => {
          const child = asObject(raw)
          if (!child) return null
          const siblings = rawChildren(node)
          return (
            <Row
              key={`${key}.${childIndex}`}
              node={child}
              path={[...path, childIndex]}
              depth={depth + 1}
              index={childIndex}
              siblingCount={siblings.length}
              selectedPath={selectedPath}
              expanded={expanded}
              issues={issues}
              onSelect={onSelect}
              onToggle={onToggle}
              onAddChild={onAddChild}
              onAddSibling={onAddSibling}
              onMove={onMove}
              onRemove={onRemove}
            />
          )
        })}
    </div>
  )
}

export function NodeTree(props: NodeTreeProps): JSX.Element {
  const { doc, status, selectedPath, expanded, issues, onSelect, onToggle } = props
  const root = rootNode(doc)
  const selectedKey = pathKey(selectedPath)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  /**
   * 选中项滚入可视区：新加的节点、树上点选都得看得见。
   * 依赖里不放 doc——编辑字段时 doc 每敲一下都换，会跟着做无用的滚动查询。
   */
  useEffect(() => {
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-path="${selectedKey}"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selectedKey, expanded])

  return (
    <section className="tpl-col tpl-col-tree" aria-label="节点树">
      <header className="tpl-col-head">
        <h2>节点树</h2>
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
            index={0}
            siblingCount={1}
            selectedPath={selectedPath}
            expanded={expanded}
            issues={issues}
            onSelect={onSelect}
            onToggle={onToggle}
            onAddChild={props.onAddChild}
            onAddSibling={props.onAddSibling}
            onMove={props.onMove}
            onRemove={props.onRemove}
          />
        )}
      </div>
    </section>
  )
}

export default NodeTree
