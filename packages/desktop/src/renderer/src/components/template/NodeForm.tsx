/**
 * 右栏：选中节点的表单。
 * 节点部分：标题、标题级别、节点类型、三个开关、说明文字，加上节点自己的增删移；
 * 内容块部分：一块一张卡片（见 BlockForm），可增删移。
 * 这一栏只写内存草稿，写文件是页脚那个「保存」按钮的事。
 */
import { useEffect, useState, type JSX } from 'react'
import { BLOCK_TYPE_NAMES } from '@documentor/core/blocks'
import type { TemplateIssueDto } from '../../../../shared/project'
import { BLOCK_TYPE_LABELS } from '../editor/blockTypes'
import BlockForm from './BlockForm'
import { AddChildIcon, AddSiblingIcon, MoveDownIcon, MoveUpIcon, PlusIcon, TrashIcon } from './icons'
import { CheckField, IssueLines, NumberField, SelectField, TextAreaField, TextField, jsonTip } from './fields'
import {
  NODE_FIELDS,
  asObject,
  headingLevel,
  nodeJsonPath,
  nodeSwitch,
  nodeType,
  nodeTitle,
  rawBlocks,
  str,
  unknownKeys,
  type NodePath,
  type TemplateDoc,
  type TemplateObject
} from './templateDoc'
import { issuesUnder } from './templateValidate'
import type { TemplateEditorStatus } from './useTemplateEditor'

interface NodeFormProps {
  doc: TemplateDoc | null
  status: TemplateEditorStatus
  node: TemplateObject | null
  path: NodePath
  /** 该节点下的全部结论（含内容块） */
  issues: TemplateIssueDto[]
  nodeTypes: string[]
  canMove: { up: boolean; down: boolean }
  onPatch: (patch: TemplateObject) => void
  onAddChild: () => void
  onAddSibling: () => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
  onBlockPatch: (index: number, patch: TemplateObject) => void
  onBlockMove: (index: number, delta: -1 | 1) => void
  onBlockRemove: (index: number) => void
  onBlockAdd: (type: string) => void
}

const BLOCK_TYPE_OPTIONS = BLOCK_TYPE_NAMES.map((name) => ({
  value: name as string,
  label: `${BLOCK_TYPE_LABELS[name]}（${name}）`
}))

export function NodeForm(props: NodeFormProps): JSX.Element {
  const { doc, status, node, path, issues, nodeTypes, canMove } = props
  const [addType, setAddType] = useState<string>(BLOCK_TYPE_NAMES[0])
  /**
   * 展开着哪几张内容块卡片：各自独立开合（同时开多张是常态——对照两张表的列或两段文本时要用）。
   * 默认开第一张；新增块自动展开它；移动/删除时下标跟着挪，别让"开着的"落到别的块上。
   */
  const [openBlocks, setOpenBlocks] = useState<ReadonlySet<number>>(new Set([0]))
  const pathKeyValue = nodeJsonPath(path)
  useEffect(() => {
    setOpenBlocks(new Set([0]))
  }, [pathKeyValue])

  const toggleBlock = (index: number): void => {
    setOpenBlocks((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  /** 块换位置时把"开着的下标"跟着换，删除时把后面的下标前移 */
  const moveBlock = (index: number, delta: -1 | 1): void => {
    const to = index + delta
    setOpenBlocks((current) => {
      if (!current.has(index) && !current.has(to)) return current
      const next = new Set(current)
      const fromOpen = next.has(index)
      const toOpen = next.has(to)
      if (fromOpen) next.delete(index)
      else next.add(index)
      if (toOpen) next.delete(to)
      else next.add(to)
      return next
    })
    props.onBlockMove(index, delta)
  }

  const removeBlock = (index: number): void => {
    setOpenBlocks((current) => {
      const next = new Set<number>()
      for (const i of current) {
        if (i === index) continue
        next.add(i > index ? i - 1 : i)
      }
      return next
    })
    props.onBlockRemove(index)
  }

  if (!node) {
    return (
      <section className="tpl-col tpl-col-insp" aria-label="节点">
        <header className="tpl-col-head">
          <h2>节点</h2>
        </header>
        <div className="tpl-col-body">
          <p className="tpl-empty">
            {doc ? '在中间选一个节点' : status === 'ready' ? '还没有打开结构模板' : '正在读取模板目录…'}
          </p>
        </div>
      </section>
    )
  }

  const isRoot = path.length === 0
  const jsonPath = nodeJsonPath(path)
  const blocks = rawBlocks(node)
  const extra = unknownKeys(node, NODE_FIELDS)
  /** 节点自己字段上的结论：内容块下面的单独挂在块卡片上，不在这里重复 */
  const nodeIssues = issues.filter(
    (issue) => !issue.path.startsWith(`${jsonPath}.contentBlocks`)
  )

  return (
    <section className="tpl-col tpl-col-insp" aria-label="节点">
      <header className="tpl-col-head">
        <h2>节点</h2>
        <code className="tpl-path" title={jsonPath}>
          {jsonPath}
        </code>
      </header>
      <div className="tpl-col-body">
        {/* 第一行：标题 / 级别 / 类型 —— 进面板第一眼就落在要改的地方 */}
        <div className="tpl-row">
          <TextField
            label="标题"
            tip={jsonTip('title', '这个节点在文档里的标题文字')}
            value={nodeTitle(node)}
            placeholder="章节标题"
            onChange={(value) => props.onPatch({ title: value })}
          />
          <NumberField
            label="级别"
            tip={jsonTip('headingLevel', '0 是根节点，1 起是章、节、条')}
            value={headingLevel(node)}
            min={0}
            onChange={(value) => props.onPatch({ headingLevel: value })}
          />
          <SelectField
            label="类型"
            tip={jsonTip('nodeType')}
            value={nodeType(node)}
            options={[
              ...(nodeType(node) === '' ? [{ value: '', label: '（未写类型）' }] : []),
              ...nodeTypes.map((type) => ({ value: type, label: type }))
            ]}
            onChange={(value) => props.onPatch({ nodeType: value })}
          />
        </div>

        {/* 第二行：三个开关 + 说明（说明的标题也排在这一行，展开才占一整行） */}
        <div className="tpl-row tpl-row-flat">
          <CheckField
            label="可复制"
            tip={jsonTip('copyable', '用户在新工程里可以复制这个节点')}
            checked={nodeSwitch(node, 'copyable')}
            onChange={(checked) => props.onPatch({ copyable: checked })}
          />
          <CheckField
            label="可删除"
            tip={jsonTip('deletable', '用户在新工程里可以删除这个节点')}
            checked={nodeSwitch(node, 'deletable')}
            onChange={(checked) => props.onPatch({ deletable: checked })}
          />
          <CheckField
            label="可加内容块"
            tip={jsonTip('allowContentBlocks', '用户在新工程里可以往这个节点加内容块')}
            checked={nodeSwitch(node, 'allowContentBlocks')}
            onChange={(checked) => props.onPatch({ allowContentBlocks: checked })}
          />
          <details className="tpl-fold tpl-fold-inline">
            <summary title={jsonTip('description', '写给作者和用户看的填写提示')}>
              说明
              {str(node['description']).trim() !== '' && (
                <span className="tpl-fold-preview">
                  {str(node['description']).split('\n').find((line) => line.trim() !== '') ?? ''}
                </span>
              )}
            </summary>
            <div className="tpl-fold-body">
              <TextAreaField
                label=""
                value={str(node['description'])}
                placeholder="给作者与用户看的填写提示（可留空）"
                rows={3}
                onChange={(value) => props.onPatch({ description: value })}
              />
            </div>
          </details>
        </div>

        {extra.length > 0 && (
          <p className="tpl-note">
            这份节点里还有界面不管的字段：{extra.join('、')}（原样保留）
          </p>
        )}

        <IssueLines issues={nodeIssues} />

        {/* 节点操作放在属性之后：面板开头先是"内容是什么"，再是"拿这个节点怎么办" */}
        <div className="tpl-actions">
          <button
            type="button"
            className="tpl-icon-btn"
            title="在它下面加一个子节点"
            aria-label="添加子节点"
            onClick={props.onAddChild}
          >
            <AddChildIcon />
          </button>
          <button
            type="button"
            className="tpl-icon-btn"
            title={isRoot ? '根节点没有同级' : '在它后面加一个同级节点'}
            aria-label="添加同级"
            disabled={isRoot}
            onClick={props.onAddSibling}
          >
            <AddSiblingIcon />
          </button>
          <button
            type="button"
            className="tpl-icon-btn"
            title="上移"
            aria-label="上移"
            disabled={!canMove.up}
            onClick={() => props.onMove(-1)}
          >
            <MoveUpIcon />
          </button>
          <button
            type="button"
            className="tpl-icon-btn"
            title="下移"
            aria-label="下移"
            disabled={!canMove.down}
            onClick={() => props.onMove(1)}
          >
            <MoveDownIcon />
          </button>
          <button
            type="button"
            className="tpl-icon-btn tpl-danger"
            title={isRoot ? '根节点不能删除' : '删除该节点及其子节点'}
            aria-label="删除节点"
            disabled={isRoot}
            onClick={props.onRemove}
          >
            <TrashIcon />
          </button>
        </div>

        <section className="tpl-blocks">
          <header className="tpl-blocks-head">
            <h3>内容块</h3>
            <span className="tpl-count">{blocks.length} 块</span>            <div className="tpl-blocks-add">
              <select
                className="tpl-select"
                value={addType}
                aria-label="要添加的内容块类型"
                onChange={(event) => setAddType(event.target.value)}
              >
                {BLOCK_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="tpl-icon-btn"
                title="把选中的类型加到这一节点的末尾"
                aria-label="添加内容块"
                onClick={() => {
                  props.onBlockAdd(addType)
                  // 新块加在末尾，直接展开它，省得再点一次（已经开着的保持开着）
                  setOpenBlocks((current) => new Set([...current, blocks.length]))
                }}
              >
                <PlusIcon />
              </button>
            </div>
          </header>
          {!nodeSwitch(node, 'allowContentBlocks') && (
            <p className="tpl-note">内容块开关关着：用户在新工程里不能往这个节点加内容块</p>
          )}
          {blocks.length === 0 ? (
            <p className="tpl-empty">这个节点还没有内容块</p>
          ) : (
            blocks.map((raw, index) => {
              const block = asObject(raw)
              if (!block) {
                return (
                  <p key={`bad-${index}`} className="tpl-issue tpl-issue-error">
                    <span className="tpl-issue-text">
                      第 {index + 1} 个内容块不是对象，程序会丢弃这一块
                    </span>
                    <code className="tpl-path" title={`${jsonPath}.contentBlocks[${index}]`}>
                      {jsonPath}.contentBlocks[{index}]
                    </code>
                  </p>
                )
              }
              return (
                <BlockForm
                  key={`${jsonPath}.contentBlocks[${index}]`}
                  block={block}
                  index={index}
                  count={blocks.length}
                  open={openBlocks.has(index)}
                  onToggle={() => toggleBlock(index)}
                  issues={issuesUnder(issues, `${jsonPath}.contentBlocks[${index}]`)}
                  onPatch={(patch) => props.onBlockPatch(index, patch)}
                  onMove={(delta) => moveBlock(index, delta)}
                  onRemove={() => removeBlock(index)}
                />
              )
            })
          )}
        </section>
      </div>
    </section>
  )
}

export default NodeForm
