/**
 * 中栏：结构模板的节点树（递归列表，可展开收起、可选中；不做拖拽）。
 * 视觉语言沿用编辑器的树：层级数字、类型角标、问题圆点；
 * 状态由外面给（选中路径 + 展开集合），组件本身无状态。
 */
import { useEffect, useRef, type JSX } from 'react'
import type { TemplateIssueDto } from '../../../../shared/project'
import { ChevronDownIcon } from '../icons'
import {
  asObject,
  hasChildren,
  headingLevel,
  nodeJsonPath,
  nodeTitle,
  nodeType,
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
        <span className="tpl-tree-type">{nodeType(node) || '—'}</span>
        {blocks > 0 && <span className="tpl-tree-count">{blocks} 块</span>}
        <IssueDot issues={under} />
      </div>
      {hasChild &&
        open &&
        rawChildren(node).map((raw, index) => {
          const child = asObject(raw)
          if (!child) return null
          return (
            <Row
              key={`${key}.${index}`}
              node={child}
              path={[...path, index]}
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
          <button type="button" className="tpl-mini" onClick={props.onExpandAll} disabled={!root}>
            全展
          </button>
          <button type="button" className="tpl-mini" onClick={props.onCollapseAll} disabled={!root}>
            全折
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
