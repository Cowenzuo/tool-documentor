/**
 * 右栏：选中节点的表单。
 * 节点部分：标题、级别（只显示，程序算的）、节点类型、说明、三个开关
 * （节点自己的增删移在节点树的行右键菜单里）；内容块部分：一块一张卡片（见 BlockForm），可增删移。
 * 这一栏只写内存草稿，写文件是页脚那个「保存」按钮的事。
 */
import { useEffect, useState, type JSX } from 'react'
import { BLOCK_TYPE_NAMES } from '@documentor/core/blocks'
import type { TemplateIssueDto } from '../../../../shared/project'
import { BLOCK_TYPE_LABELS, describeBlockType } from '../editor/blockTypes'
import BlockForm from './BlockForm'
import { ContextMenu, useContextMenu } from './ContextMenu'
import { CheckField, IssueLines, SelectField, TextAreaField, TextField, jsonTip } from './fields'
import {
  NODE_FIELDS,
  asObject,
  blockLock,
  blockType,
  breadcrumbOf,
  headingLevel,
  isPinnedLock,
  nodeJsonPath,
  nodeKind,
  nodeSwitch,
  nodeType,
  nodeTitle,
  normalNodeTypeFor,
  rawBlocks,
  str,
  subTitleDepthOf,
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
  onBlockAdd: (type: string, index?: number) => void
  onBlockDuplicate: (index: number) => void
}

/**
 * 加内容块的类型菜单：与文档编辑那边同一份内容（人话名字 + 一句说明），
 * 从块间的缝或末尾那个虚线框里弹出来。
 */
function AddBlockMenu({ onPick }: { onPick: (type: string) => void }): JSX.Element {
  return (
    <div className="tpl-add-menu" role="menu" aria-label="要加的内容块类型">
      {BLOCK_TYPE_NAMES.map((name) => (
        <button
          key={name}
          type="button"
          role="menuitem"
          title={describeBlockType(name)}
          onClick={() => onPick(name as string)}
        >
          <span className="tpl-add-label">{BLOCK_TYPE_LABELS[name]}</span>
          <span className="tpl-add-desc">{describeBlockType(name)}</span>
        </button>
      ))}
    </div>
  )
}

export function NodeForm(props: NodeFormProps): JSX.Element {
  const { doc, status, node, path, issues } = props
  /** 类型菜单开在哪一格：null 关着，数字 = 插到该下标之前（blocks.length 就是末尾） */
  const [insertAt, setInsertAt] = useState<number | null>(null)
  /** 内容块卡片的右键菜单（上方插入 / 下方插入 / 复制这一块） */
  const blockMenu = useContextMenu<{ index: number }>()
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

  /** 插一块：开着的下标整体后移，新块直接摊开（省得再点一次） */
  const insertBlock = (type: string, index: number): void => {
    setOpenBlocks((current) => {
      const next = new Set<number>()
      for (const i of current) next.add(i >= index ? i + 1 : i)
      next.add(index)
      return next
    })
    setInsertAt(null)
    props.onBlockAdd(type, index)
  }

  /** 复制一块：拷贝插在它下面，同样摊开新那一份 */
  const duplicateBlock = (index: number): void => {
    setOpenBlocks((current) => {
      const next = new Set<number>()
      for (const i of current) next.add(i > index ? i + 1 : i)
      next.add(index + 1)
      return next
    })
    props.onBlockDuplicate(index)
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
   * 级别是程序算的、不是作者填的：新建节点时按父节点的层级 + 1 写进文件，已有的值原样保留
   * （模板里偶尔故意写得比树浅，比如重复单元沿用上一级的样式），界面照它显示——
   * 这个数字就是导出取哪套标题样式（heading.N）的那个 N。
   * 正因为是算出来的，界面**不报"层级不一致"**：没有"作者填错"这回事。
   */
  const depth = path.length
  const level = headingLevel(node)
  /** 字段名只差大小写（headingLevel 写成 headinglevel 这种）：程序会当没写，必须让人看见 */
  const typo = typoField(node, NODE_FIELDS)
  /** 相邻块是不是锁着的（keep/readonly）：换位会把它挪走，所以邻居那一侧也不给挪 */
  const pinnedAt = (index: number): boolean => {
    const block = asObject(blocks[index])
    return block ? isPinnedLock(blockLock(block)) : false
  }
  /** 节点自己字段上的结论：内容块下面的单独挂在块卡片上，不在这里重复 */
  const nodeIssues = issues.filter(
    (issue) => !issue.path.startsWith(`${jsonPath}.contentBlocks`)
  )
  /** 卡片菜单的标题：第几块 + 类型，让人一眼认出这单冲着谁 */
  const menuBlock = blockMenu.payload ? asObject(blocks[blockMenu.payload.index]) : null
  const blockMenuHead = menuBlock
    ? `第 ${(blockMenu.payload?.index ?? 0) + 1} 块 · ${
        (BLOCK_TYPE_LABELS as Record<string, string>)[blockType(menuBlock)] ?? blockType(menuBlock)
      }`
    : ''

  /** 类型只按用途选，两种：层级标题 / 列表子标题（chapter、section 这些词程序不读） */
  const kindOptions: Array<{ value: string; label: string }> = [
    { value: 'heading', label: '层级标题' },
    { value: 'listSubTitle', label: '列表子标题' }
  ]
  if (kind === 'unknown') kindOptions.push({ value: 'unknown', label: `（原值：${nodeType(node)}）` })

  const applyKind = (value: string): void => {
    if (value === 'heading') {
      // 层级标题保持文件里原来的写法（chapter/section/repeatable 没有语义差别，不顺手改写）
      if (kind === 'heading') return
      props.onPatch({ nodeType: normalNodeTypeFor(depth) })
      return
    }
    if (value === 'listSubTitle') props.onPatch({ nodeType: 'subTitle' })
  }

  return (
    <section className="tpl-col tpl-col-insp" aria-label="节点">
      <header className="tpl-col-head">
        <h2>节点</h2>
        {/* 级别当信息看（跟树上那枚徽标同一个数）：它决定导出用哪套标题样式 */}
        <span
          className="tpl-level"
          title={isRoot ? '根节点：整篇文档' : `第 ${level} 级标题：导出用这套标题样式`}
        >
          {isRoot ? '根' : `${level} 级`}
        </span>
        {/* 位置写人话（示例文档 › 需求）：JSON 路径留给悬停，版面不印下标 */}
        <span className="tpl-where" title={jsonPath}>
          {where}
        </span>
      </header>
      <div className="tpl-col-body">
        {/* 第一行：标题 / 类型。三个开关搭在「标题」标签那一行的空处——
            它们不占这一行的宽度份额，所以标题输入框与类型下拉都不会被挤窄 */}
        <div className="tpl-row">
          <TextField
            label="标题"
            htmlFor="tpl-node-title"
            tip={jsonTip('title', '这个节点在文档里的标题文字')}
            value={nodeTitle(node)}
            placeholder="章节标题"
            extra={
              <span className="tpl-switches" role="group" aria-label="用户在新工程里能做什么">
                <CheckField
                  label="复制"
                  tip={jsonTip('copyable', '用户在新工程里可以复制这个节点')}
                  checked={nodeSwitch(node, 'copyable')}
                  onChange={(checked) => props.onPatch({ copyable: checked })}
                />
                <CheckField
                  label="裁剪"
                  tip={jsonTip('deletable', '用户在新工程里可以删除（裁剪掉）这个节点')}
                  checked={nodeSwitch(node, 'deletable')}
                  onChange={(checked) => props.onPatch({ deletable: checked })}
                />
                <CheckField
                  label="编辑"
                  tip={jsonTip(
                    'allowContentBlocks',
                    '用户在新工程里可以往这个节点加内容块（已有的内容能不能改，看每一块自己的锁）'
                  )}
                  checked={nodeSwitch(node, 'allowContentBlocks')}
                  onChange={(checked) => props.onPatch({ allowContentBlocks: checked })}
                />
              </span>
            }
            onChange={(value) => props.onPatch({ title: value })}
          />
          <SelectField
            label="类型"
            tip={jsonTip(
              'nodeType',
              '只按用途分两种：层级标题（进章节编号链） / 列表子标题（不占编号链，导出按 a/b/c 编号）'
            )}
            value={isRoot ? 'heading' : kind}
            options={kindOptions}
            disabled={isRoot}
            disabledWhy="根节点是整篇文档，没有可选的类型"
            onChange={applyKind}
          />
        </div>

        {kind === 'listSubTitle' && (
          <p className="tpl-note">
            列表子标题：不占章节编号链，导出时按同级里的 a/b/c 编号（样式 subtitle.
            {subTitleDepthOf(doc, path)}）
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

        {typo !== null && (
          <p className="tpl-note tpl-note-bad">
            这份节点里的「{typo.key}」与「{typo.known}」只差大小写，程序按没写处理（改过来才会生效）
          </p>
        )}

        <IssueLines issues={nodeIssues} />

        <section className="tpl-blocks">
          <header className="tpl-blocks-head">
            <h3>内容块</h3>
            <span className="tpl-count">{blocks.length} 块</span>
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
                <div className="tpl-block-slot" key={`${jsonPath}.contentBlocks[${index}]`}>
                  {/* 块间的缝：悬停才显形，鼠标扫过去就知道这里能插（与文档编辑那边同一个手势） */}
                  <div className={`tpl-insert${insertAt === index ? ' is-open' : ''}`}>
                    <button
                      type="button"
                      className="tpl-insert-btn"
                      aria-expanded={insertAt === index}
                      aria-label={`在第 ${index + 1} 块上方插入内容块`}
                      title="在第这一块上方插入"
                      onClick={() => setInsertAt(insertAt === index ? null : index)}
                    >
                      ＋ 在此插入
                    </button>
                    {insertAt === index && (
                      <AddBlockMenu onPick={(type) => insertBlock(type, index)} />
                    )}
                  </div>
                  <BlockForm
                    block={block}
                    index={index}
                    count={blocks.length}
                    open={openBlocks.has(index)}
                    onToggle={() => toggleBlock(index)}
                    prevLocked={pinnedAt(index - 1)}
                    nextLocked={pinnedAt(index + 1)}
                    issues={issuesUnder(issues, `${jsonPath}.contentBlocks[${index}]`)}
                    onPatch={(patch) => props.onBlockPatch(index, patch)}
                    onMove={(delta) => moveBlock(index, delta)}
                    onRemove={() => removeBlock(index)}
                    onOpenMenu={(x: number, y: number) => blockMenu.openIn({ index }, x, y)}
                  />
                </div>
              )
            })
          )}

          {/* 末尾追加：虚线框，与文档编辑那边同一个语言 */}
          <div className={`tpl-add${insertAt === blocks.length ? ' is-open' : ''}`}>
            <button
              type="button"
              className="tpl-add-btn"
              aria-expanded={insertAt === blocks.length}
              title="在末尾添加内容块"
              onClick={() => setInsertAt(insertAt === blocks.length ? null : blocks.length)}
            >
              ＋ 添加内容
            </button>
            {insertAt === blocks.length && (
              <AddBlockMenu onPick={(type) => insertBlock(type, blocks.length)} />
            )}
          </div>
        </section>
      </div>
      {/* 内容块卡片的右键菜单：插入与复制在这儿（挪/删是卡片上那两个按钮，菜单里不重复） */}
      {blockMenu.payload && (
        <ContextMenu
          control={blockMenu}
          className="tpl-block-menu"
          label="内容块操作"
          head={blockMenuHead}          items={[
            {
              label: '上方插入',
              title: '在这一块上面插入一块',
              run: () => setInsertAt(blockMenu.payload!.index)
            },
            {
              label: '下方插入',
              title: '在这一块下面插入一块',
              run: () => setInsertAt(blockMenu.payload!.index + 1)
            },
            {
              label: '复制这一块',
              title: '把这一块连同内容与锁复制一份，插在它下面',
              run: () => duplicateBlock(blockMenu.payload!.index)
            }
          ]}
        />
      )}
    </section>
  )
}

export default NodeForm
