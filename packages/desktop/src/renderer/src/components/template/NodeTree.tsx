/**
 * 中栏：结构模板的节点树（递归列表，可展开收起、可选中；不做拖拽）。
 * 视觉语言沿用编辑器的树：层级数字、需要时才有的一枚类型标记、问题圆点；
 * 状态由外面给（选中路径 + 展开集合），组件本身无状态。
 *
 * 增删移这一排放在栏头（「节点树」与展开/折叠旁边），做的是"选中的那一个"：
 * 行上不挂按钮——一行本来就只有二十来个字，挤上五个按钮标题就得让位；
 * 按钮的悬停提示里带上选中节点的名字，按的是谁一眼能对上。
 */
import { useEffect, useRef, type JSX } from 'react'
import type { TemplateIssueDto } from '../../../../shared/project'
import { ChevronDownIcon } from '../icons'
import { AddChildIcon, AddSiblingIcon, CollapseAllIcon, ExpandAllIcon, MoveDownIcon, MoveUpIcon, TrashIcon } from './icons'
import {
  asObject,
  hasChildren,
  headingLevel,
  nodeAt,
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
  selectedPath,
  expanded,
  issues,
  onSelect,
  onToggle
}: {
  node: TemplateObject
  path: NodePath
  depth: number
  selectedPath: NodePath
  expanded: Set<string>
  issues: TemplateIssueDto[]
  onSelect: (path: NodePath) => void
  onToggle: (key: string) => void
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
      </div>
      {hasChild &&
        open &&
        rawChildren(node).map((raw, childIndex) => {
          const child = asObject(raw)
          if (!child) return null
          return (
            <Row
              key={`${key}.${childIndex}`}
              node={child}
              path={[...path, childIndex]}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              issues={issues}
              onSelect={onSelect}
              onToggle={onToggle}
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

  const selected = nodeAt(doc, selectedPath)
  const isRootSelected = selectedPath.length === 0
  const index = selectedPath[selectedPath.length - 1] ?? 0
  const parent = nodeAt(doc, selectedPath.slice(0, -1))
  const siblingCount = parent ? rawChildren(parent).length : 0
  const name = selected ? nodeTitle(selected) || '（未命名）' : ''
  const canMoveUp = selected !== null && !isRootSelected && index > 0
  const canMoveDown = selected !== null && !isRootSelected && index < siblingCount - 1
  const noNode = '先在中栏选一个节点'
  /** 按钮的悬停提示：按不了的说原因，按得了的说清按的是谁（根节点那几条原因相同） */
  const opTitle = (ready: string, blocked: string): string => {
    if (selected === null) return noNode
    if (isRootSelected) return '选中的是根节点：没有同级，也不能移动、不能删除'
    return blocked === '' ? ready : blocked
  }

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
        {/* 结构操作：对选中的那一个节点办事，所以贴在这一栏的头上 */}
        <div className="tpl-tree-ops">
          <button
            type="button"
            className="tpl-icon-btn"
            title={selected === null ? noNode : `在「${name}」下面加一个子节点`}
            aria-label="添加子节点"
            disabled={selected === null}
            onClick={() => props.onAddChild(selectedPath)}
          >
            <AddChildIcon />
          </button>
          <button
            type="button"
            className="tpl-icon-btn"
            title={opTitle(`在「${name}」后面加一个同级节点`, '')}
            aria-label="添加同级"
            disabled={selected === null || isRootSelected}
            onClick={() => props.onAddSibling(selectedPath)}
          >
            <AddSiblingIcon />
          </button>
          <button
            type="button"
            className="tpl-icon-btn"
            title={opTitle(`「${name}」上移`, canMoveUp ? '' : '已经是第一个子节点')}
            aria-label="上移"
            disabled={!canMoveUp}
            onClick={() => props.onMove(selectedPath, -1)}
          >
            <MoveUpIcon />
          </button>
          <button
            type="button"
            className="tpl-icon-btn"
            title={opTitle(`「${name}」下移`, canMoveDown ? '' : '已经是最后一个子节点')}
            aria-label="下移"
            disabled={!canMoveDown}
            onClick={() => props.onMove(selectedPath, 1)}
          >
            <MoveDownIcon />
          </button>
          <button
            type="button"
            className="tpl-icon-btn tpl-danger"
            title={opTitle(`删除「${name}」及其子节点`, '')}
            aria-label="删除节点"
            disabled={selected === null || isRootSelected}
            onClick={() => props.onRemove(selectedPath)}
          >
            <TrashIcon />
          </button>
        </div>
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
            selectedPath={selectedPath}
            expanded={expanded}
            issues={issues}
            onSelect={onSelect}
            onToggle={onToggle}
          />
        )}
      </div>
    </section>
  )
}

export default NodeTree
