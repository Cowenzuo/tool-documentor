/**
 * 右栏：选中节点的表单。
 * 节点部分：标题、级别（只显示，程序算的）、节点类型、说明、三个开关
 * （节点自己的增删移在节点树的行右键菜单里）；内容块部分：一块一张卡片（见 BlockForm），可增删移。
 * 这一栏只写内存草稿，写文件是页脚那个「保存」按钮的事。
 */
import { useEffect, useState, type JSX } from 'react'
import { BLOCK_TYPE_NAMES } from '@documentor/core/blocks'
import type { TemplateEntryDto, TemplateIssueDto } from '../../../../shared/project'
import { BLOCK_TYPE_LABELS, describeBlockType } from '../editor/blockTypes'
import BlockForm from './BlockForm'
import { ContextMenu, useContextMenu } from './ContextMenu'
import { CheckField, IssueLines, SelectField, TextAreaField, TextField, jsonTip } from './fields'
import {
  NODE_FIELDS,
  asObject,
  blockType,
  breadcrumbOf,
  headingLevel,
  groupFixFor,
  kindChangeProblem,
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
  /** 这个目录里的样式模板（根节点那一节选默认样式用） */
  styles: TemplateEntryDto[]
  onPatch: (patch: TemplateObject) => void
  /** 改整份模板级的字段：默认样式不在节点里，得写顶层 */
  onPatchDoc: (patch: TemplateObject) => void
  /** 把这一组改齐（同级不许混的"直接修复"） */
  onGroupFix: () => void
  onBlockPatch: (index: number, patch: TemplateObject) => void
  onBlockMove: (index: number, delta: -1 | 1) => void
  onBlockRemove: (index: number) => void
  onBlockAdd: (type: string, index?: number) => void
  onBlockDuplicate: (index: number) => void
  /** 选一张本机图片（对话框在主进程）：图片块的路径字段用它，不用手抄路径 */
  onPickImage: () => Promise<string | null>
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
          onClick={() => onPick(name as string)}
        >
          <span className="tpl-add-label">{BLOCK_TYPE_LABELS[name]}</span>
          {/* 说明就在按钮上写着，不再挂一份一样的 title */}
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

  /**
   * 根节点上的"这份结构用哪份样式"：
   *   - `defaultStyleUuid` 就是导出时取的那一份；写了但目录里没有，就是悬挂，要重选；
   *   - 下拉里列这个目录里能读出来的全部样式，选一个写进去。
   * 名字只作展示：这份结构是谁看 `cn` / `en`，与根节点标题常常不一样。
   */
  const declaredDefault = doc ? str(doc['defaultStyleUuid']) : ''
  const danglingDefault =
    declaredDefault !== '' && !props.styles.some((entry) => entry.uuid === declaredDefault)
  const styleChoices: Array<{ value: string; label: string }> = [
    // 悬挂那份先占一个位置：当前值得看得见，选了别的才换掉
    ...(danglingDefault ? [{ value: declaredDefault, label: '找不到这份样式' }] : []),
    { value: '', label: '未指定' },
    ...[...props.styles]
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
      .map((entry) => ({
        value: entry.uuid,
        label: entry.en === '' ? entry.name : `${entry.name} · ${entry.en}`
      }))
  ]

  /** 类型只按用途选，两种：层级标题 / 列表子标题（chapter、section 这些词程序不读） */
  const kindOptions: Array<{ value: string; label: string }> = [
    { value: 'heading', label: '层级标题' },
    { value: 'listSubTitle', label: '列表子标题' }
  ]
  if (kind === 'unknown') kindOptions.push({ value: 'unknown', label: `（原值：${nodeType(node)}）` })

  /**
   * 类型也不是随便改的：同一父节点下不许混（见 templateDoc 的 `kindChangeProblem`），
   * 列表子标题下面也不许挂层级标题。这一头或那一头不允许时，下拉就灰着并说明为什么。
   */
  const otherKind = kind === 'listSubTitle' ? 'heading' : 'listSubTitle'
  const kindProblem =
    isRoot || kind === 'unknown' ? null : kindChangeProblem(doc, path, otherKind)
  const kindLocked = isRoot || kindProblem !== null
  const kindWhy = isRoot ? '根节点是整篇文档，没有可选的类型' : (kindProblem ?? '')
  /**
   * 已经混着的那一组：单改一个还是混着（程序会拦），所以给一个整组动作。
   * 合规的结构没有这个动作——它只在真出问题时出现。
   */
  const groupFix = groupFixFor(doc, path)

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
          title={isRoot ? '整篇文档' : `导出取 heading.${level}`}
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
            tip={jsonTip('title')}
            value={nodeTitle(node)}
            placeholder="章节标题"
            extra={
              <span className="tpl-switches" role="group" aria-label="用户在新工程里能做什么">
                <CheckField
                  label="复制"
                  tip={jsonTip('copyable', '缺省 false · 用户能不能把这一章连子树复制一份')}
                  checked={nodeSwitch(node, 'copyable')}
                  onChange={(checked) => props.onPatch({ copyable: checked })}
                />
                <CheckField
                  label="裁剪"
                  tip={jsonTip('deletable', '缺省 false · 用户能不能删掉这一章')}
                  checked={nodeSwitch(node, 'deletable')}
                  onChange={(checked) => props.onPatch({ deletable: checked })}
                />
                <CheckField
                  label="编辑"
                  tip={jsonTip(
                    'allowContentBlocks',
                    '缺省 true · 内容块总闸：关掉整章内容块只读，一个字段都不能改'
                  )}
                  checked={nodeSwitch(node, 'allowContentBlocks')}
                  onChange={(checked) => props.onPatch({ allowContentBlocks: checked })}
                />
                <CheckField
                  label="排版"
                  tip={jsonTip(
                    'allowLayoutEdit',
                    '缺省 true · 关掉后集合、顺序、类型都固定，只能改各块的内容'
                  )}
                  checked={nodeSwitch(node, 'allowLayoutEdit')}
                  onChange={(checked) => props.onPatch({ allowLayoutEdit: checked })}
                />
              </span>
            }
            onChange={(value) => props.onPatch({ title: value })}
          />
          <SelectField
            label="类型"
            tip={jsonTip('nodeType', '取值 heading / listSubTitle')}
            value={isRoot ? 'heading' : kind}
            options={kindOptions}
            disabled={kindLocked}
            disabledWhy={kindWhy === '' ? undefined : kindWhy}
            onChange={applyKind}
          />
        </div>

        {/* 类型改不动时给一句原因：这一条不是"报错"，是这个结构改不了 */}
        {kindProblem !== null && <p className="tpl-note tpl-note-kind">{kindProblem} · 类型不可改</p>}

        {/* 这一组已经不合规：不给"一个个改"（改一个还是混着），给一个整组动作 */}
        {groupFix && groupFix.paths.length > 0 && (
          <p className="tpl-note tpl-note-kind tpl-note-fix">
            {groupFix.why}
            <button
              type="button"
              className="tpl-mini tpl-inline-action"
              title={`改 ${groupFix.paths.length} 个 · 目标 ${
                groupFix.target === 'heading' ? '层级标题' : '列表子标题'
              }`}
              onClick={props.onGroupFix}
            >
              把这一组改齐（都改成{groupFix.target === 'heading' ? '层级标题' : '列表子标题'}）
            </button>
          </p>
        )}

        {kind === 'listSubTitle' && (
          <p className="tpl-note">
            不占章节编号链 · 导出取 subtitle.{subTitleDepthOf(doc, path)}
          </p>
        )}

        {/* 第二行：说明常驻（写给作者与用户的填写提示），排在三个开关前面 */}
        <TextAreaField
          label="说明"
          tip={jsonTip('description')}
          value={str(node['description'])}
          placeholder="给作者与用户看的填写提示（可留空）"
          rows={3}
          onChange={(value) => props.onPatch({ description: value })}
        />

        {typo !== null && (
          <p className="tpl-note tpl-note-bad">
            「{typo.key}」与「{typo.known}」只差大小写 · 程序按未写处理
          </p>
        )}

        {/* 默认样式只在根节点上选：一份结构用哪份样式，是"整份模板"的事 */}
        {isRoot && (
          <section className="tpl-style-refs">
            <header className="tpl-blocks-head">
              <h3>默认样式</h3>
            </header>
            {props.styles.length === 0 ? (
              <p className="tpl-empty">左栏「样式模板」导入一份，或直接放进模板目录</p>
            ) : (
              <>
                <SelectField
                  label=""
                  value={declaredDefault}
                  options={styleChoices}
                  onChange={(value) =>
                    props.onPatchDoc({ defaultStyleUuid: value === '' ? undefined : value })
                  }
                />
                {danglingDefault && (
                  <p className="tpl-note tpl-note-bad">默认样式找不到 · 可能已被删除，重选一份</p>
                )}
                {declaredDefault === '' && (
                  <p className="tpl-note">未指定默认样式 · 导出时先选一份</p>
                )}
              </>
            )}
          </section>
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
                    issues={issuesUnder(issues, `${jsonPath}.contentBlocks[${index}]`)}
                    onPatch={(patch) => props.onBlockPatch(index, patch)}
                    onMove={(delta) => moveBlock(index, delta)}
                    onRemove={() => removeBlock(index)}
                    onOpenMenu={(x: number, y: number) => blockMenu.openIn({ index }, x, y)}
                    onPickImage={props.onPickImage}
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
