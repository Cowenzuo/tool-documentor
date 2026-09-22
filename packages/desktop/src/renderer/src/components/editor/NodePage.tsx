/**
 * 节点文档页：标题行内编辑 + 节点信息徽标区 + 编制说明（可编辑）+ 内容块流。
 * 块编辑器挂起值经防抖提交；切换/保存前统一 flush（复刻 collectEdits 语义）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ContentBlock } from '@documentor/core/blocks'
import { BLOCK_TYPE_NAMES, type BlockTypeName } from '@documentor/core/blocks'
import { convertBlock, type BlockConversion } from '@documentor/core/block-convert'
import { BLOCK_ACTION, NODE_PERMISSION, blockPermissions } from '../../../../shared/permissionTerms'
import { useApp, useSelectedNode } from '../../state/AppContext'
import { BlockCard } from './BlockCard'
import type { LightboxRequest } from './BlockEditors'
import { BLOCK_ADD_ORDER, BLOCK_TYPE_LABELS, describeBlockType } from './blockTypes'
import { Lightbox } from '../Lightbox'

const DEBOUNCE_MS = 600

/** 结构变更的种类：发起方登记，对账时按它搬运块的稳定键 */
type StructureOp =
  | { kind: 'add' }
  | { kind: 'insert'; index: number }
  | { kind: 'remove'; index: number }
  | { kind: 'move'; from: number; to: number }

/** 登记的有效期：失败的操作不该在很久之后误伤下一次对账 */
const STRUCTURE_OP_TTL_MS = 5000

function newBlockKey(): string {
  return crypto.randomUUID()
}

/**
 * 按登记的结构变更加工稳定键。
 * 只在长度与预期吻合时才采纳，否则退回整批新键——宁可重挂载，也不能张冠李戴。
 */
function reconcileKeys(prev: string[], incomingLength: number, op: StructureOp | null): string[] {
  if ((op?.kind === 'add' || op?.kind === 'insert') && prev.length === incomingLength - 1) {
    if (op.kind === 'add') return [...prev, newBlockKey()]
    const next = [...prev]
    next.splice(Math.max(0, Math.min(op.index, next.length)), 0, newBlockKey())
    return next
  }
  if (op?.kind === 'remove' && prev.length === incomingLength + 1) {
    return prev.filter((_, i) => i !== op.index)
  }
  if (op?.kind === 'move' && prev.length === incomingLength) {
    const next = [...prev]
    const [moved] = next.splice(op.from, 1)
    if (moved !== undefined) next.splice(op.to, 0, moved)
    return next
  }
  if (prev.length === incomingLength) return prev
  return Array.from({ length: incomingLength }, () => newBlockKey())
}

/** 添加内容的下拉菜单：末尾「＋ 添加内容」与块间插入共用同一份 */
function AddBlockMenu({
  onPick
}: {
  onPick: (type: (typeof BLOCK_ADD_ORDER)[number]) => void
}): React.JSX.Element {
  return (
    <div className="np-add-menu">
      {BLOCK_ADD_ORDER.map((type) => (
        <button
          key={type}
          type="button"
          title={describeBlockType(type)}
          onClick={() => onPick(type)}
        >
          <span className="np-add-label">{BLOCK_TYPE_LABELS[type]}</span>
          <span className="np-add-desc">{describeBlockType(type)}</span>
        </button>
      ))}
    </div>
  )
}

export default function NodePage(): React.JSX.Element {
  const node = useSelectedNode()
  const {
    addContentBlock,
    removeContentBlock,
    moveContentBlock,
    updateContentBlock,
    setNodeTitle,
    setNodeDescription,
    registerFlushAll
  } = useApp()

  const [blocks, setBlocks] = useState<ContentBlock[]>(node?.contentBlocks ?? [])
  const [desc, setDesc] = useState(node?.description ?? '')
  const [lightbox, setLightbox] = useState<LightboxRequest | null>(null)
  /** 添加菜单的开合位置：null 关闭，'end' 末尾，数字表示插到该下标之前 */
  const [addOpen, setAddOpen] = useState<'end' | number | null>(null)
  /** 换类型菜单：开在哪一块上、按视口坐标摆在哪 */
  const [typeMenu, setTypeMenu] = useState<{ index: number; x: number; y: number } | null>(null)
  /** 会丢字的那几路：先问一句，确认了才换 */
  const [pendingConvert, setPendingConvert] = useState<
    { index: number; type: BlockTypeName; conversion: BlockConversion } | null
  >(null)
  /** 防抖缓冲里还有没进工程数据的改动：界面上要看得见，别让人以为已经写好了 */
  const [editing, setEditing] = useState(false)
  /** 折叠的块：按节点记，切走再回来还认得（块本身没有稳定 id，只能记下标） */
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const collapsedByNodeRef = useRef(new Map<string, Set<number>>())

  const pendingRef = useRef(new Map<number, ContentBlock>())
  const timersRef = useRef(new Map<number, number>())
  const nodeIdRef = useRef<string | null>(null)
  /** 换类型菜单的 DOM 引用：点外面关、开完按视口收边 */
  const typeMenuRef = useRef<HTMLDivElement | null>(null)
  /** 上一次与 store 对账过的块序列；用于识别"store 侧发生了结构性变化" */
  const storeSignatureRef = useRef('')
  /**
   * 界面上这份块序列的镜像：对账时除了比 store 的签名，还要比它一眼。
   *
   * 只比 store 的签名不够。用户刚打的字先落在本地（防抖缓冲里），store 还没动；这时若 store
   * 的签名回到上一次对账时那个值（撤销正是如此），按签名判就会跳过同步，那次打字留在界面上，
   * 树其实已经退回去了 —— 用户看到"撤销没生效"，切一下章节才恢复（见 PLAN-21）。
   */
  const blocksRef = useRef<ContentBlock[]>(blocks)
  blocksRef.current = blocks
  const descValueRef = useRef(desc)
  const descDirtyRef = useRef(false)
  const descTimerRef = useRef<number | undefined>(undefined)
  /** 标题同样走防抖提交：以前只在失焦时保存，编辑到一半切节点或保存就丢了 */
  const titleValueRef = useRef(node?.title ?? '')
  const titleDirtyRef = useRef(false)
  const titleTimerRef = useRef<number | undefined>(undefined)
  /** 非受控标题框的 DOM 引用：外部改回标题时要回写它 */
  const titleRef = useRef<HTMLInputElement | null>(null)
  /**
   * 块的前端稳定键：用下标当 key 时，一次"上移"会把两张卡片整体重挂载，
   * 正在编辑的光标、滚动位置、图片上传忙碌态全丢。这里按块对象配一把键，
   * 结构变更（增删移）由发起方登记，对账时按登记把键跟着搬。
   */
  const [blockKeys, setBlockKeys] = useState<string[]>([])
  const structureOpRef = useRef<{ op: StructureOp; at: number } | null>(null)

  useEffect(() => {
    descValueRef.current = desc
  }, [desc])

  /** 编制说明框随内容长高，超过 40vh 才内部滚动（高度上限写在 CSS 里） */
  const descRef = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const el = descRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [desc, node?.id])

  /** 切章节回到顶部：滚动容器不随节点重建，不主动归零就会停在上一章的位置 */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [node?.id])

  // 切换节点/挂载：重建缓存视图
  useEffect(() => {
    nodeIdRef.current = node?.id ?? null
    const initialDesc = node?.description ?? ''
    const initialBlocks = node?.contentBlocks ?? []
    setBlocks(initialBlocks)
    setBlockKeys(initialBlocks.map(() => newBlockKey()))
    setDesc(initialDesc === '无' ? '' : initialDesc)
    setCollapsed(new Set(collapsedByNodeRef.current.get(node?.id ?? '') ?? []))
    descDirtyRef.current = false
    titleValueRef.current = node?.title ?? ''
    titleDirtyRef.current = false
    structureOpRef.current = null
    pendingRef.current.clear()
    for (const timer of timersRef.current.values()) window.clearTimeout(timer)
    timersRef.current.clear()
    window.clearTimeout(descTimerRef.current)
    storeSignatureRef.current = (node?.contentBlocks ?? []).map((b) => JSON.stringify(b)).join('\u0000')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node?.id])

  /**
   * 外部改回来的标题与编制说明要回写到输入框。
   * 撤销与重做会把整棵树换掉，而非受控标题框只在换章节时重建，
   * 不回写就会出现"树已经退回去了、框里还留着新字"。
   * 正在编辑（本地脏、还没落定）时不动它，免得把光标打断。
   */
  useEffect(() => {
    if (!node || node.id !== nodeIdRef.current) return
    const servedTitle = node.title ?? ''
    const input = titleRef.current
    if (input && !titleDirtyRef.current && input.value !== servedTitle) {
      input.value = servedTitle
    }
    const servedDesc = (node.description ?? '') === '无' ? '' : (node.description ?? '')
    if (!descDirtyRef.current && descValueRef.current !== servedDesc) {
      setDesc(servedDesc)
    }
  }, [node?.title, node?.description, node?.id])

  /**
   * 与 store 对账：新增/删除/移动内容块之后，服务端才是权威——
   * store 侧块序列一变就按它整表覆盖缓存（保留尚未 flush 的编辑缓冲）。
   *
   * 只依赖 node?.id 重建缓存是不够的：增删移都不改节点 id，
   * 会出现"数据已经删了、卡片还在界面上"的假象，用户再点一次反而收到
   * "内容位置不对"的报错。
   */
  useEffect(() => {
    if (!node || node.id !== nodeIdRef.current) return
    const incoming = node.contentBlocks
    const signature = incoming.map((b) => JSON.stringify(b)).join('\u0000')
    const localSignature = (blocksRef.current ?? []).map((b) => JSON.stringify(b)).join('\u0000')
    // store 没变**且界面也还跟它一致**才跳过：界面已经分叉就必须按 store 覆盖回来
    if (signature === storeSignatureRef.current && signature === localSignature) return
    storeSignatureRef.current = signature
    setBlocks(
      incoming.map((b, i) => {
        const pending = pendingRef.current.get(i)
        // 该下标还有未提交的编辑：以本地待提交值为准，避免打字被回滚
        return pending ? pending : b
      })
    )
    const registered = structureOpRef.current
    const op =
      registered && Date.now() - registered.at <= STRUCTURE_OP_TTL_MS ? registered.op : null
    structureOpRef.current = null
    setBlockKeys((prev) => reconcileKeys(prev, incoming.length, op))
  }, [node?.contentBlocks])

  /**
   * 提交全部挂起编辑（标题 + 编制说明 + 内容块），**等它们真的写下去**。
   *
   * 返回值必须等：保存、切换节点、撤销与重做都会先调它。只"喊一声"就走的话，
   * 撤销会赶在这次编辑之前执行 —— 撤掉的是上一步，而这次编辑随后自己落地，
   * 用户看到的是"按了 Ctrl+Z，字还在"（见 PLAN-21）。
   */
  const flushPending = useCallback(async () => {
    const nodeId = nodeIdRef.current
    const writes: Array<Promise<void>> = []
    // 标题
    window.clearTimeout(titleTimerRef.current)
    if (titleDirtyRef.current && nodeId) {
      titleDirtyRef.current = false
      writes.push(setNodeTitle(nodeId, titleValueRef.current))
    }
    // 编制说明
    window.clearTimeout(descTimerRef.current)
    if (descDirtyRef.current && nodeId) {
      descDirtyRef.current = false
      writes.push(setNodeDescription(nodeId, descValueRef.current))
    }
    // 内容块
    for (const [index, block] of [...pendingRef.current]) {
      const timer = timersRef.current.get(index)
      if (timer !== undefined) window.clearTimeout(timer)
      pendingRef.current.delete(index)
      timersRef.current.delete(index)
      if (nodeId) writes.push(updateContentBlock(nodeId, index, block))
    }
    setEditing(false)
    await Promise.all(writes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setNodeDescription, setNodeTitle, updateContentBlock])

  // 向 store 注册本页 flush（保存/关闭/切换节点/撤销前调用）
  useEffect(() => registerFlushAll(flushPending), [registerFlushAll, flushPending])

  // 卸载时提交挂起编辑（组件要走了，不等结果）
  useEffect(() => () => void flushPending(), [flushPending])

  const onDescChange = useCallback(
    (value: string) => {
      setDesc(value)
      descValueRef.current = value
      descDirtyRef.current = true
      setEditing(true)
      window.clearTimeout(descTimerRef.current)
      descTimerRef.current = window.setTimeout(flushPending, DEBOUNCE_MS)
    },
    [flushPending]
  )

  const onTitleChange = useCallback(
    (value: string) => {
      titleValueRef.current = value
      titleDirtyRef.current = true
      setEditing(true)
      window.clearTimeout(titleTimerRef.current)
      titleTimerRef.current = window.setTimeout(flushPending, DEBOUNCE_MS)
    },
    [flushPending]
  )

  const handleChange = useCallback(
    (index: number, block: ContentBlock) => {
      setBlocks((prev) => prev.map((b, i) => (i === index ? block : b)))
      pendingRef.current.set(index, block)
      setEditing(true)
      const prevTimer = timersRef.current.get(index)
      if (prevTimer !== undefined) window.clearTimeout(prevTimer)
      const nodeId = nodeIdRef.current
      const timer = window.setTimeout(() => {
        pendingRef.current.delete(index)
        timersRef.current.delete(index)
        if (nodeId) void updateContentBlock(nodeId, index, block)
      }, DEBOUNCE_MS)
      timersRef.current.set(index, timer)
    },
    [updateContentBlock]
  )

  /**
   * 真正把换类型写下去。
   *
   * 先 `flushPending`：这一块可能还有 600ms 防抖里的挂起编辑，那一份是**旧类型**的块，
   * 不先写完就换，定时器到点会把类型改动静默改回去（加块、删块、移动三处同理）。
   * 两次写入共用同一个合并键，撤销时算一步（PLAN-20 第 4 件）。
   */
  const applyConversion = useCallback(
    async (index: number, conversion: BlockConversion) => {
      const nodeId = nodeIdRef.current
      setPendingConvert(null)
      if (!nodeId) return
      await flushPending()
      await updateContentBlock(nodeId, index, conversion.block)
    },
    [flushPending, updateContentBlock]
  )

  /** 换类型：按 core 那份搬运规则算出新块；有字会丢的先问一句 */
  const handleChangeType = useCallback(
    async (index: number, type: BlockTypeName) => {
      setTypeMenu(null)
      const current = blocks[index]
      if (!current || current.type === type) return
      const conversion = convertBlock(current, type)
      if (conversion.losesText) {
        setPendingConvert({ index, type, conversion })
        return
      }
      await applyConversion(index, conversion)
    },
    [blocks, applyConversion]
  )

  // 换类型菜单：点外面、按 Esc 关；开完按视口收边，别把菜单摆到窗口外
  useEffect(() => {
    if (!typeMenu) return
    const close = (event: MouseEvent): void => {
      const target = event.target as Node
      if (typeMenuRef.current && !typeMenuRef.current.contains(target)) setTypeMenu(null)
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setTypeMenu(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key)
    }
  }, [typeMenu])

  useLayoutEffect(() => {
    const el = typeMenuRef.current
    if (!typeMenu || !el) return
    const rect = el.getBoundingClientRect()
    const overflowX = rect.right - window.innerWidth + 8
    const overflowY = rect.bottom - window.innerHeight + 8
    if (overflowX > 0 || overflowY > 0) {
      setTypeMenu((prev) =>
        prev
          ? { ...prev, x: prev.x - Math.max(0, overflowX), y: prev.y - Math.max(0, overflowY) }
          : prev
      )
    }
  }, [typeMenu])

  /** 菜单里的上下键：在当前类型那一项上跳过（它是灰的） */
  const onTypeMenuKeyDown = useCallback((event: React.KeyboardEvent): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [
      ...(typeMenuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
    ]
    if (items.length === 0) return
    const at = items.findIndex((el) => el === document.activeElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length
    items[next]?.focus()
  }, [])

  const handleAdd = useCallback(
    async (type: (typeof BLOCK_ADD_ORDER)[number], atIndex?: number) => {      const nodeId = nodeIdRef.current
      if (!nodeId) return
      await flushPending()
      structureOpRef.current = {
        op: typeof atIndex === 'number' ? { kind: 'insert', index: atIndex } : { kind: 'add' },
        at: Date.now()
      }
      await addContentBlock(nodeId, type, atIndex)
    },
    [flushPending, addContentBlock]
  )

  const handleRemove = useCallback(
    async (index: number) => {
      const nodeId = nodeIdRef.current
      if (!nodeId) return
      await flushPending()
      structureOpRef.current = { op: { kind: 'remove', index }, at: Date.now() }
      await removeContentBlock(nodeId, index)
    },
    [flushPending, removeContentBlock]
  )

  const handleMove = useCallback(
    async (index: number, direction: -1 | 1) => {
      const nodeId = nodeIdRef.current
      if (!nodeId) return
      await flushPending()
      structureOpRef.current = { op: { kind: 'move', from: index, to: index + direction }, at: Date.now() }
      await moveContentBlock(nodeId, index, index + direction)
    },
    [flushPending, moveContentBlock]
  )

  /** 折叠状态按节点存，切走再回来还认得 */
  const toggleCollapse = useCallback((index: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      const nodeId = nodeIdRef.current
      if (nodeId) collapsedByNodeRef.current.set(nodeId, next)
      return next
    })
  }, [])

  const setAllCollapsed = useCallback(
    (value: boolean) => {
      const next = value ? new Set(blocks.map((_, i) => i)) : new Set<number>()
      setCollapsed(next)
      const nodeId = nodeIdRef.current
      if (nodeId) collapsedByNodeRef.current.set(nodeId, next)
    },
    [blocks]
  )

  if (!node) {
    return (
      <main className="node-page node-page-empty">
        <div className="np-hint">未选中章节</div>
      </main>
    )
  }

  /** 这一章的块能做什么：编辑与排版两个开关取交，界面与写入侧同一份判定 */
  const perms = blockPermissions(node)

  return (
    <main className="node-page">
      <div className="np-scroll" ref={scrollRef}>
        <article className="np-article">
          <div className="np-head">
            <input
              className="np-title"
              ref={titleRef}
              defaultValue={node.title}
              key={node.id}
              aria-label="章节标题"
              onChange={(e) => onTitleChange(e.target.value)}
              onBlur={(e) => {
                // 失焦立即提交，不等防抖
                titleValueRef.current = e.target.value
                titleDirtyRef.current = true
                flushPending()
              }}
            />
            {editing && (
              <span className="np-dirty" title="待写入">
                编辑中…
              </span>
            )}
            <div className="np-badges">
              {node.headingLevel === 0 ? (
                <span className="np-badge">文档根</span>
              ) : node.isSubTitle ? (
                <span className="np-badge np-badge-sub">列表子标题</span>
              ) : (
                <span className="np-badge">标题级别 {node.headingLevel}</span>
              )}
              {/*
                只列能做的事：以前把三个否定标签也摆出来，读着像出错。
                词与模板编辑器的四个开关同一份（见 shared/permissionTerms），悬停给模板的许可。
              */}
              {node.copyable && (
                <span className="np-chip np-chip-ok" title={NODE_PERMISSION.copyable.tip}>
                  {NODE_PERMISSION.copyable.name}
                </span>
              )}
              {node.deletable && (
                <span className="np-chip np-chip-ok" title={NODE_PERMISSION.deletable.tip}>
                  {NODE_PERMISSION.deletable.name}
                </span>
              )}
              {node.allowContentBlocks && (
                <span className="np-chip np-chip-ok" title={NODE_PERMISSION.allowContentBlocks.tip}>
                  {NODE_PERMISSION.allowContentBlocks.name}
                </span>
              )}
              {node.allowLayoutEdit && (
                <span className="np-chip np-chip-ok" title={NODE_PERMISSION.allowLayoutEdit.tip}>
                  {NODE_PERMISSION.allowLayoutEdit.name}
                </span>
              )}
              {!node.copyable && !node.deletable && !node.allowContentBlocks && !node.allowLayoutEdit && (
                <span
                  className="np-chip"
                  title="模板限定：复制、裁剪、内容块与排版都关着，标题与编制说明照常可改"
                >
                  内容只读
                </span>
              )}
            </div>
          </div>

          <textarea
            className="np-desc-editor"
            ref={descRef}
            value={desc}
            onChange={(e) => onDescChange(e.target.value)}
            placeholder="编制说明（可选）…"
            aria-label="编制说明"
          />

          {!perms.editContent && node.contentBlocks.length === 0 ? (
            <div className="np-block-hint">模板把这一章的编辑关着，内容块不能改</div>
          ) : (
            <div className="np-blocks">
              {blocks.length > 0 && (
                <div className="np-blocks-toolbar">
                  <span className="np-blocks-count">{blocks.length} 项内容</span>
                  <button
                    type="button"
                    className="be-btn be-btn-mini"
                    onClick={() => setAllCollapsed(collapsed.size < blocks.length)}
                  >
                    {collapsed.size < blocks.length ? '全部折叠' : '全部展开'}
                  </button>
                </div>
              )}
              {blocks.map((block, index) => (
                <div className="np-block-slot" key={blockKeys[index] ?? `${node.id}:${index}`}>
                  {perms.add && (
                    <div className="np-insert">
                      {/* 位置归「排版」管：排版开着，插在任何位置都允许 */}
                      <button
                        type="button"
                        className="np-insert-btn"
                        title="在此上方插入内容"
                        aria-label={`在第 ${index + 1} 项上方插入内容`}
                        aria-expanded={addOpen === index}
                        onClick={() => setAddOpen((v) => (v === index ? null : index))}
                      >
                        ＋ 在此插入
                      </button>
                      {addOpen === index && (
                        <AddBlockMenu
                          onPick={(type) => {
                            setAddOpen(null)
                            void handleAdd(type, index)
                          }}
                        />
                      )}
                    </div>
                  )}
                  <BlockCard
                    nodeId={node.id}
                    index={index}
                    block={block}
                    perms={perms}
                    collapsed={collapsed.has(index)}
                    onToggleCollapse={toggleCollapse}
                    canMoveUp={index > 0}
                    canMoveDown={index < blocks.length - 1}
                    onChange={handleChange}
                    onMove={(i, d) => void handleMove(i, d)}
                    onRemove={(i) => void handleRemove(i)}
                    onPreview={(req) => setLightbox(req)}
                    onOpenTypeMenu={(i, anchor) => setTypeMenu({ index: i, x: anchor.x, y: anchor.y })}
                    typeMenuOpen={typeMenu?.index === index}
                  />
                  {/* 换类型会丢字的那几路：先把"丢什么"摆在按钮上方，确认了才换 */}
                  {pendingConvert?.index === index && (
                    <div
                      className="be-confirm np-type-confirm"
                      role="alertdialog"
                      aria-label={`确认${BLOCK_ACTION.changeType.name}`}
                    >
                      <div>
                        换成{BLOCK_TYPE_LABELS[pendingConvert.type]}会丢掉
                        {pendingConvert.conversion.dropped.join('、')}，确定吗？
                      </div>
                      <div className="be-confirm-actions">
                        <button
                          type="button"
                          className="be-btn danger-text"
                          onClick={() => void applyConversion(pendingConvert.index, pendingConvert.conversion)}
                        >
                          换成{BLOCK_TYPE_LABELS[pendingConvert.type]}
                        </button>
                        <button type="button" className="be-btn" onClick={() => setPendingConvert(null)}>
                          取消
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {perms.add && (
                <div className="np-add">
                  <button
                    type="button"
                    className="np-add-btn"
                    onClick={() => setAddOpen((v) => (v === 'end' ? null : 'end'))}
                    aria-expanded={addOpen === 'end'}
                  >
                    ＋ 添加内容
                  </button>
                  {addOpen === 'end' && (
                    <AddBlockMenu
                      onPick={(type) => {
                        setAddOpen(null)
                        void handleAdd(type)
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          )}
        </article>
      </div>
      {lightbox && <Lightbox request={lightbox} onClose={() => setLightbox(null)} />}
      {/*
        换类型菜单按视口坐标摆（卡片自己 overflow: hidden，菜单摆在里面会被裁掉），
        与结构栏那个右键菜单同一个做法。当前类型那一项灰着，让人看得出自己现在是什么。
      */}
      {typeMenu && (
        <div
          ref={typeMenuRef}
          className="np-type-menu"
          role="menu"
          aria-label={BLOCK_ACTION.changeType.name}
          style={{ left: typeMenu.x, top: typeMenu.y }}
          onKeyDown={onTypeMenuKeyDown}
        >
          {BLOCK_TYPE_NAMES.map((type) => {
            const current = blocks[typeMenu.index]?.type === type
            return (
              <button
                key={type}
                type="button"
                role="menuitem"
                disabled={current}
                title={current ? '已经是这个类型' : describeBlockType(type)}
                onClick={() => void handleChangeType(typeMenu.index, type)}
              >
                <span className="np-add-label">{BLOCK_TYPE_LABELS[type]}</span>
                <span className="np-add-desc">{current ? '当前类型' : describeBlockType(type)}</span>
              </button>
            )
          })}
        </div>
      )}
    </main>
  )
}
