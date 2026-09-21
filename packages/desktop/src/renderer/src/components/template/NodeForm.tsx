/**
 * 右栏：选中节点的表单。
 * 节点部分：标题、标题级别、节点类型、说明、三个开关（节点自己的增删移在节点树的行右键菜单里）；
 * 内容块部分：一块一张卡片（见 BlockForm），可增删移。
 * 这一栏只写内存草稿，写文件是页脚那个「保存」按钮的事。
 */
import { useEffect, useState, type JSX } from 'react'
import { BLOCK_TYPE_NAMES } from '@documentor/core/blocks'
import type { TemplateIssueDto } from '../../../../shared/project'
import { BLOCK_TYPE_LABELS } from '../editor/blockTypes'
import BlockForm from './BlockForm'
import { PlusIcon } from './icons'
import { CheckField, IssueLines, SelectField, TextAreaField, TextField, jsonTip } from './fields'
import {
  NODE_FIELDS,
  asObject,
  breadcrumbOf,
  headingLevel,
  nodeJsonPath,
  nodeKind,
  nodeSwitch,
  nodeType,
  nodeTitle,
  normalNodeTypeFor,
  rawBlocks,
  str,
  typoField,
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
  onPatch: (patch: TemplateObject) => void
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
  const { doc, status, node, path, issues } = props
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
  const where = breadcrumbOf(doc, path)
  const blocks = rawBlocks(node)
  const kind = nodeKind(node)
  /**
   * 级别跟着树里的层级走（第几层就是几级标题），不给人手改：
   * 它决定导出时用哪套标题样式（heading.N）与主编辑器里"谁能挂在谁下面"，
   * 而"文件里写的"和"树里在第几层"不一致时，界面得说出来——这才是作者要判断的东西。
   */
  const depth = path.length
  const stored = headingLevel(node)
  const levelOff = !isRoot && stored !== depth
  /** 字段名只差大小写（headingLevel 写成 headinglevel 这种）：程序会当没写，必须让人看见 */
  const typo = typoField(node, NODE_FIELDS)
  /** 节点自己字段上的结论：内容块下面的单独挂在块卡片上，不在这里重复 */
  const nodeIssues = issues.filter(
    (issue) => !issue.path.startsWith(`${jsonPath}.contentBlocks`)
  )

  /** 类型只按"用途"选：chapter/section 这两个词程序不读，写哪个都不影响行为 */
  const kindOptions: Array<{ value: string; label: string }> = [
    { value: 'normal', label: '常规标题' },
    { value: 'subTitle', label: '副标题' },
    { value: 'repeatable', label: '可复制组' }
  ]
  if (kind === 'unknown') kindOptions.push({ value: 'unknown', label: `（原值：${nodeType(node)}）` })

  const applyKind = (value: string): void => {
    if (value === 'normal') {
      // 常规标题保持文件里原来的写法（chapter/section 没有语义差别，不顺手改写）
      if (kind === 'normal') return
      props.onPatch({ nodeType: normalNodeTypeFor(depth) })
      return
    }
    if (value === 'subTitle') props.onPatch({ nodeType: 'subTitle' })
    else if (value === 'repeatable') props.onPatch({ nodeType: 'repeatable' })
  }

  return (
    <section className="tpl-col tpl-col-insp" aria-label="节点">
      <header className="tpl-col-head">
        <h2>节点</h2>
        {/* 级别是树里的位置给的，在这儿当信息看：它决定导出用哪套标题样式 */}
        <span
          className={`tpl-level${levelOff ? ' is-off' : ''}`}
          title={
            isRoot
              ? '根节点：整篇文档'
              : levelOff
                ? `文件里写的是 ${stored} 级标题，树里在第 ${depth} 层`
                : `第 ${depth} 级标题（跟着树里的层级，导出用这套标题样式）`
          }
        >
          {isRoot ? '根' : `${depth} 级`}
        </span>
        {/* 位置写人话（示例文档 › 需求）：JSON 路径留给悬停，版面不印下标 */}
        <span className="tpl-where" title={jsonPath}>
          {where}
        </span>
      </header>
      <div className="tpl-col-body">
        {/* 第一行：标题 / 类型 —— 进面板第一眼就落在要改的地方 */}
        <div className="tpl-row">
          <TextField
            label="标题"
            tip={jsonTip('title', '这个节点在文档里的标题文字')}
            value={nodeTitle(node)}
            placeholder="章节标题"
            onChange={(value) => props.onPatch({ title: value })}
          />
          <SelectField
            label="类型"
            tip={jsonTip(
              'nodeType',
              '只按用途分：常规标题 / 副标题（不占编号链，导出按 a/b/c） / 可复制组'
            )}
            value={isRoot ? 'normal' : kind}
            options={kindOptions}
            disabled={isRoot}
            disabledWhy="根节点是整篇文档，没有可选的类型"
            onChange={applyKind}
          />
        </div>

        {levelOff && (
          <p className="tpl-note tpl-note-bad">
            文件里写的是 {stored} 级标题，树里在第 {depth} 层：导出按 {stored} 级标题的样式排版。
            <button
              type="button"
              className="tpl-mini tpl-inline-action"
              onClick={() => props.onPatch({ headingLevel: depth })}
            >
              改成 {depth} 级
            </button>
          </p>
        )}

        {kind === 'subTitle' && (
          <p className="tpl-note">
            副标题：不占章节编号链，导出时按同级里的 a/b/c 编号（样式 subtitle.{depth}）
          </p>
        )}
        {kind === 'repeatable' && (
          <p className="tpl-note">
            可复制组：这一组的节点同属一个复制组（copyGroupId），用户在新工程里按组复制
          </p>
        )}

        {/* 第二行：说明常驻（写给作者与用户的填写提示），排在三个开关前面 */}
        <TextAreaField
          label="说明"
          tip={jsonTip('description', '写给作者和用户看的填写提示')}
          value={str(node['description'])}
          placeholder="给作者与用户看的填写提示（可留空）"
          rows={3}
          onChange={(value) => props.onPatch({ description: value })}
        />

        {/* 第三行：三个开关 —— 决定用户在新工程里能对这个节点做什么 */}
        <div className="tpl-row tpl-row-flat">
          <CheckField
            label="复制"
            tip={jsonTip('copyable', '用户在新工程里可以复制这个节点')}
            checked={nodeSwitch(node, 'copyable')}
            onChange={(checked) => props.onPatch({ copyable: checked })}
          />
          <CheckField
            label="删除"
            tip={jsonTip('deletable', '用户在新工程里可以删除这个节点')}
            checked={nodeSwitch(node, 'deletable')}
            onChange={(checked) => props.onPatch({ deletable: checked })}
          />
          <CheckField
            label="加内容"
            tip={jsonTip(
              'allowContentBlocks',
              '用户在新工程里可以往这个节点加内容块（已有的内容能不能改，看每一块自己的锁）'
            )}
            checked={nodeSwitch(node, 'allowContentBlocks')}
            onChange={(checked) => props.onPatch({ allowContentBlocks: checked })}
          />
        </div>

        {typo !== null && (
          <p className="tpl-note tpl-note-bad">
            这份节点里的「{typo.key}」与「{typo.known}」只差大小写，程序按没写处理（改过来才会生效）
          </p>
        )}

        <IssueLines issues={nodeIssues} />

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
