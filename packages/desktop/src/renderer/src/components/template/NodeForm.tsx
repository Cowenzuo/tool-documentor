/**
 * 右栏：选中节点的表单。
 * 节点部分：标题、标题级别、节点类型、三个开关、说明文字，加上节点自己的增删移；
 * 内容块部分：一块一张卡片（见 BlockForm），可增删移。
 * 这一栏只写内存草稿，写文件是页脚那个「保存」按钮的事。
 */
import { useState, type JSX } from 'react'
import { BLOCK_TYPE_NAMES } from '@documentor/core/blocks'
import type { TemplateIssueDto } from '../../../../shared/project'
import { BLOCK_TYPE_LABELS } from '../editor/blockTypes'
import BlockForm from './BlockForm'
import { CheckField, IssueLines, NumberField, SelectField, TextAreaField, TextField } from './fields'
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
        <code className="tpl-path">{jsonPath}</code>
      </header>
      <div className="tpl-col-body">
        <div className="tpl-actions">
          <button type="button" className="tpl-mini" onClick={props.onAddChild}>
            添加子节点
          </button>
          <button type="button" className="tpl-mini" onClick={props.onAddSibling} disabled={isRoot}>
            添加同级
          </button>
          <button
            type="button"
            className="tpl-mini"
            onClick={() => props.onMove(-1)}
            disabled={!canMove.up}
          >
            上移
          </button>
          <button
            type="button"
            className="tpl-mini"
            onClick={() => props.onMove(1)}
            disabled={!canMove.down}
          >
            下移
          </button>
          <button
            type="button"
            className="tpl-mini tpl-danger"
            onClick={props.onRemove}
            disabled={isRoot}
            title={isRoot ? '根节点不能删除' : '删除该节点及其子节点'}
          >
            删除
          </button>
        </div>

        <div className="tpl-grid-2">
          <TextField
            label="标题（title）"
            value={nodeTitle(node)}
            placeholder="章节标题"
            onChange={(value) => props.onPatch({ title: value })}
          />
          <NumberField
            label="标题级别（headingLevel）"
            value={headingLevel(node)}
            min={0}
            onChange={(value) => props.onPatch({ headingLevel: value })}
          />
        </div>
        <SelectField
          label="节点类型（nodeType）"
          value={nodeType(node)}
          options={[
            ...(nodeType(node) === '' ? [{ value: '', label: '（未写类型）' }] : []),
            ...nodeTypes.map((type) => ({ value: type, label: type }))
          ]}
          hint="取自这份模板里出现过的取值"
          onChange={(value) => props.onPatch({ nodeType: value })}
        />
        <div className="tpl-switches">
          <CheckField
            label="可复制（copyable）"
            checked={nodeSwitch(node, 'copyable')}
            title="用户在新工程里可以复制这个节点"
            onChange={(checked) => props.onPatch({ copyable: checked })}
          />
          <CheckField
            label="可删除（deletable）"
            checked={nodeSwitch(node, 'deletable')}
            title="用户在新工程里可以删除这个节点"
            onChange={(checked) => props.onPatch({ deletable: checked })}
          />
          <CheckField
            label="可加内容块（allowContentBlocks）"
            checked={nodeSwitch(node, 'allowContentBlocks')}
            title="用户在新工程里可以往这个节点加内容块"
            onChange={(checked) => props.onPatch({ allowContentBlocks: checked })}
          />
        </div>
        <TextAreaField
          label="说明文字（description）"
          hint="给作者和用户看的填写提示"
          rows={4}
          value={str(node['description'])}
          onChange={(value) => props.onPatch({ description: value })}
        />
        {extra.length > 0 && (
          <p className="tpl-note">
            这份节点里还有界面不管的字段：{extra.join('、')}（原样保留）
          </p>
        )}

        <IssueLines issues={nodeIssues} />

        <section className="tpl-blocks">
          <header className="tpl-blocks-head">
            <h3>内容块</h3>
            <span className="tpl-count">{blocks.length} 块</span>
            <div className="tpl-blocks-add">
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
              <button type="button" className="tpl-mini" onClick={() => props.onBlockAdd(addType)}>
                添加
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
                    <code className="tpl-path">
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
                  issues={issuesUnder(issues, `${jsonPath}.contentBlocks[${index}]`)}
                  onPatch={(patch) => props.onBlockPatch(index, patch)}
                  onMove={(delta) => props.onBlockMove(index, delta)}
                  onRemove={() => props.onBlockRemove(index)}
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
