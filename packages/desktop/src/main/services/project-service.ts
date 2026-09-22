/**
 * 工程服务（主进程）：工程生命周期 + 文档树/内容块变更（权威执行与校验）。
 * renderer 的每一次编辑经 IPC 在此同步执行；SQLite 落库仅在显式保存。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  bodyRowCount,
  checkTableShape,
  dbPathOf,
  HISTORY_MAX_BYTES,
  HISTORY_MAX_STEPS,
  HistoryStack,
  localIsoNow,
  ProjectStore,
  readAnchor,
  TABLE_MAX_COLS,
  TABLE_MAX_ROWS,
  writeAnchor,
  ANCHOR_FILE_NAME,
  type ProjectAnchor
} from '@documentor/core'
import type { DocumentTree, DocumentNode } from '@documentor/core/tree'
import { createBlock, type BlockTypeName, type ContentBlock } from '@documentor/core/blocks'
import { exportTreeToDocxWithFigures, collectMermaidFigures, resolveMmdFacade, skeletonTextWidthTwips } from '@documentor/docx'
import { displayNameOf } from '@documentor/templates'
import type { TemplateManager } from '@documentor/templates'
import type {
  BlockAddInput,
  BlockIndexInput,
  BlockMoveInput,
  BlockUpdateInput,
  CopyNodeResult,
  CreateProjectInput,
  ExportDocxInput,
  ExportDocxResult,
  FileWriteBytesInput,
  HistoryResultDto,
  HistoryStateDto,
  HistoryJumpInput,
  ImageImportInput,
  NodeCopyInput,
  NodeDeleteInput,
  NodeDescriptionInput,
  NodeTitleInput,
  ProjectInfoDto,
  ProjectOpenResult,
  PrecheckResult,
  SaveAndCloseResult,
  SaveResult
} from '../../shared/project'
import { toNodeDto } from './dto'

export class ProjectServiceError extends Error {}

/**
 * 一步撤销的存档：`nodeId` 是这份快照覆盖的那个节点（子树），撤销与重做都写回它。
 * 只存受影响的子树而不是整棵树：代价与子树成正比，不随章节数放大。
 */
interface TreeSnapshot {
  nodeId: string
  node: DocumentNode
}

export class ProjectService {
  private treeValue: DocumentTree | null = null
  private anchorValue: ProjectAnchor | null = null
  private projectDirValue = ''
  private store = new ProjectStore()
  private managerValue: TemplateManager
  /** 会话级撤销栈：跟着当前打开的工程走，开关工程时清空 */
  private readonly history = new HistoryStack<TreeSnapshot>({
    maxSteps: HISTORY_MAX_STEPS,
    maxBytes: HISTORY_MAX_BYTES,
    measure: estimateSnapshotBytes
  })

  constructor(manager: TemplateManager) {
    this.managerValue = manager
  }

  /** 模板目录热重载后替换（不打断当前会话） */
  setManager(manager: TemplateManager): void {
    this.managerValue = manager
  }

  getManager(): TemplateManager {
    return this.managerValue
  }

  get tree(): DocumentTree | null {
    return this.treeValue
  }

  get projectDir(): string {
    return this.projectDirValue
  }

  get isOpen(): boolean {
    return this.treeValue !== null
  }

  // ================= 生命周期 =================

  /** 切换工程前先存好当前工程；存不上就不切，避免把改动丢掉 */
  private closeOpenProjectBeforeSwitch(): void {
    if (!this.isOpen) return
    const result = this.saveAndCloseProject()
    if (!result.ok) {
      throw new ProjectServiceError(`当前工程保存失败，未切换：${result.error}`)
    }
  }

  createProject(input: CreateProjectInput): ProjectOpenResult {
    this.closeOpenProjectBeforeSwitch()

    const projectDir = join(input.workspaceDir, input.name)
    if (existsSync(projectDir)) {
      throw new ProjectServiceError('已存在同名工程')
    }
    const template = this.managerValue.findStructureByUuid(input.templateUuid)
    if (!template) {
      throw new ProjectServiceError('未找到结构模板')
    }

    mkdirSync(projectDir, { recursive: true })
    const tree = this.managerValue.instantiate(template)
    if (!tree) throw new ProjectServiceError('模板实例化失败')

    const dbPath = join(projectDir, 'documentor.db')
    this.store.create(dbPath, input.name, input.templateUuid)
    try {
      this.store.save(tree)
    } catch (err) {
      this.store.close()
      throw new ProjectServiceError(`工程创建失败：${String(err)}`)
    }

    const now = localIsoNow()
    const anchor: ProjectAnchor = {
      version: 1,
      name: input.name,
      template_uuid: input.templateUuid,
      db_file: 'documentor.db',
      created_at: now,
      updated_at: now
    }
    writeAnchor(projectDir, anchor)

    this.treeValue = tree
    this.anchorValue = anchor
    this.projectDirValue = projectDir
    // 历史不跨工程：新工程从空栈开始
    this.history.clear()
    return this.openResult()
  }

  openProject(dprojPath: string): ProjectOpenResult {
    this.closeOpenProjectBeforeSwitch()
    const projectDir = dirname(dprojPath)
    const anchor = readAnchor(projectDir)
    if (!anchor) {
      throw new ProjectServiceError(`无效的工程文件：${dprojPath}`)
    }
    const dbPath = dbPathOf(projectDir, anchor)
    if (!existsSync(dbPath)) {
      throw new ProjectServiceError(`工程数据库不存在：${dbPath}`)
    }
    this.store.open(dbPath)
    try {
      this.treeValue = this.store.load()
    } catch (err) {
      this.store.close()
      throw new ProjectServiceError(`工程加载失败：${String(err)}`)
    }
    this.anchorValue = anchor
    this.projectDirValue = projectDir
    this.resolveTemplateRef(anchor)
    // 历史不跨工程：换一个工程就从空栈开始
    this.history.clear()
    return this.openResult()
  }

  /**
   * 认这份工程用的是哪份结构模板。新工程库里就是 uuid，直接读；
   * 老工程（PLAN-12 之前）库里与锚点里只有模板名，按名字认一次 uuid —— 认到就换过来记，
   * 认不到就留着名字（`legacyTemplateName` 会带到界面），不猜、不写空 uuid。
   */
  private resolveTemplateRef(anchor: ProjectAnchor): void {
    if (this.store.templateUuid() !== '') return
    const legacyName = this.store.legacyTemplateName() || anchor.legacyTemplateName || ''
    if (legacyName === '') return
    const def = this.managerValue.findStructureByLegacyName(legacyName)
    if (!def) {
      // 名字留在锚点里，下次打开还能再认一次
      this.anchorValue = { ...anchor, legacyTemplateName: legacyName }
      return
    }
    this.store.setTemplateUuid(def.uuid)
    this.anchorValue = { ...anchor, template_uuid: def.uuid, legacyTemplateName: '' }
  }

  saveProject(): SaveResult {
    const tree = this.requireTree()
    this.store.save(tree)
    // 落库即封口：保存前后的编辑不并成一步，免得撤销跨过一次保存
    this.history.seal()
    const now = localIsoNow()
    if (this.anchorValue) {
      this.anchorValue = { ...this.anchorValue, updated_at: now }
      writeAnchor(this.projectDirValue, this.anchorValue)
    }
    return { savedAt: now }
  }

  /**
   * 保存并关闭（切换工程/退出前）。
   * 保存失败时**不关闭工程**，把错误交回调用方：静默关闭会让用户以为已经存上了。
   */
  saveAndCloseProject(): SaveAndCloseResult {
    if (!this.isOpen) return { ok: true }
    try {
      this.saveProject()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[project] auto-save failed:', message)
      return { ok: false, error: message }
    }
    this.closeProject()
    return { ok: true }
  }

  closeProject(): void {
    this.treeValue = null
    this.anchorValue = null
    this.projectDirValue = ''
    this.store.close()
    this.history.clear()
  }

  projectInfo(): ProjectInfoDto {
    const templateUuid = this.store.templateUuid()
    const template = templateUuid === '' ? undefined : this.managerValue.findStructureByUuid(templateUuid)
    return {
      name: this.store.projectName(),
      templateUuid,
      // 模板没了就是悬挂：名字留空，导出那一头会拦下来
      templateName: template ? displayNameOf(template) : '',
      // 老工程还没认成 uuid 时把那个名字带出来，界面据此说明"是哪一份没认到"。
      // 认到之后不再报：库里那一列是留着当线索的，不该当成"还没认到"
      legacyTemplateName:
        templateUuid === ''
          ? this.store.legacyTemplateName() || this.anchorValue?.legacyTemplateName || ''
          : '',
      projectDir: this.projectDirValue,
      dprojPath: join(this.projectDirValue, ANCHOR_FILE_NAME)
    }
  }

  /** renderer 重取当前整树（打开工程/恢复时使用） */
  treeGetRoot(): ProjectOpenResult {
    return this.openResult()
  }

  private openResult(): ProjectOpenResult {
    const root = this.requireTree().root
    const warnings = this.store.loadWarnings()
    return {
      info: this.projectInfo(),
      root: toNodeDto(root),
      ...(warnings.length > 0 ? { warnings } : {})
    }
  }

  // ================= 树变更 =================
  // 会改树的方法一律套 withSnapshot：先验后改，拒绝的写入不入栈

  setNodeTitle(input: NodeTitleInput): void {
    const node = this.requireNode(input.nodeId)
    this.withSnapshot('修改标题', node, `node:title:${node.id}`, () => {
      node.title = input.title
    })
  }

  setNodeDescription(input: NodeDescriptionInput): void {
    const node = this.requireNode(input.nodeId)
    this.withSnapshot('修改编制说明', node, `node:desc:${node.id}`, () => {
      node.description = input.description
    })
  }

  copyNode(input: NodeCopyInput): CopyNodeResult {
    const node = this.requireNode(input.nodeId)
    if (node.isRoot()) throw new ProjectServiceError('根章节不能复制')
    if (!node.copyable) throw new ProjectServiceError('该章节不允许复制')
    const parent = node.parent
    if (!parent) throw new ProjectServiceError('找不到上级章节')
    // 动的是父节点的子级名单，快照存父节点
    return this.withSnapshot('复制章节', parent, null, () => {
      const clone = node.deepClone()
      const index = parent.children.indexOf(node) + 1
      parent.insertChildAt(index, clone)
      return { node: toNodeDto(clone), index }
    })
  }

  deleteNode(input: NodeDeleteInput): void {
    const node = this.requireNode(input.nodeId)
    if (node.isRoot()) throw new ProjectServiceError('根章节不能删除')
    if (!node.deletable) throw new ProjectServiceError('该章节不允许删除')
    const parent = node.parent
    if (!parent) throw new ProjectServiceError('找不到上级章节')
    // 同复制：动的是父节点的子级名单，快照存父节点
    this.withSnapshot('删除章节', parent, null, () => {
      parent.removeChild(node)
    })
  }

  /**
   * 当前工程的正文栏宽（twips），供预览按导出栏宽排版。
   * 取结构与导出同一份样式：结构里写的那个默认样式；没配或找不到就没有栏宽。
   * 解析交给 docx 包的骨架解析函数，界面侧不另算一份。
   */
  pageTextWidthTwips(): number | null {
    if (!this.isOpen) return null
    const def = this.managerValue.findStructureByUuid(this.store.templateUuid())
    if (!def) return null
    const styleDef = this.managerValue.styleForStructure(def).style
    if (!styleDef) return null
    return skeletonTextWidthTwips(styleDef.skeletonPath)
  }

  // ================= 内容块变更 =================
  addBlock(input: BlockAddInput): number {
    const node = this.requireNode(input.nodeId)
    this.assertBlocksAllowed(node)
    // 插在锁定块前面等于把它往后挤：keep/readonly 是"必须存在 + 位置也不能变"
    if (typeof input.index === 'number') {
      const pushed = node.contentBlocks.findIndex(
        (block, i) => i >= input.index! && isBlockPinned(block.lock)
      )
      if (pushed >= 0) {
        throw new ProjectServiceError(
          `模板规定第 ${pushed + 1} 块必须存在、位置也不能变：不能往它前面插内容`
        )
      }
    }
    const block = createBlock(input.type)
    return this.withSnapshot('添加内容', node, null, () => {
      // 带 index 就是"插到这一项之前"，不带就追加到末尾
      if (typeof input.index === 'number') {
        node.insertContentBlock(input.index, block)
      } else {
        node.addContentBlock(block)
      }
      return node.contentBlocks.length
    })
  }

  removeBlock(input: BlockIndexInput): number {
    const node = this.requireNode(input.nodeId)
    const existing = node.contentBlocks[input.index]
    if (!existing) throw new ProjectServiceError('内容位置不对，请刷新后重试')
    // 模板锁在这里也要拦一道：界面按档位置灰只是提示，写入侧才是最后一道
    if (isBlockPinned(existing.lock)) {
      throw new ProjectServiceError(lockRefusal(existing.lock, 'remove'))
    }
    return this.withSnapshot('删除内容', node, null, () => {
      if (!node.removeContentBlockAt(input.index)) {
        throw new ProjectServiceError('内容位置不对，请刷新后重试')
      }
      return node.contentBlocks.length
    })
  }

  moveBlock(input: BlockMoveInput): void {
    const node = this.requireNode(input.nodeId)
    const from = node.contentBlocks[input.from]
    const to = node.contentBlocks[input.to]
    if (!from || !to) throw new ProjectServiceError('内容位置不对，请刷新后重试')
    // 交换是双向的：目标位置上的块同样会被挪走，两边都要看
    for (const block of [from, to]) {
      if (isBlockPinned(block.lock)) {
        throw new ProjectServiceError(lockRefusal(block.lock, 'move'))
      }
    }
    this.withSnapshot('移动内容', node, null, () => {
      node.swapContentBlocks(input.from, input.to)
    })
  }

  updateBlock(input: BlockUpdateInput): void {
    const node = this.requireNode(input.nodeId)
    const existing = node.contentBlocks[input.index]
    if (!existing) throw new ProjectServiceError('内容位置不对，请刷新后重试')
    if (existing.type !== input.block.type) {
      // 模板锁只锁类型：这条拦的是改类型，内容变更照常放行
      throw new ProjectServiceError(
        existing.lock
          ? '模板规定该内容的类型不能改，内容可以照常编辑'
          : '内容类型不能直接改，请删除后重新添加'
      )
    }
    if (existing.lock === 'readonly') {
      throw new ProjectServiceError(lockRefusal(existing.lock, 'edit'))
    }
    assertTableShape(input.block)
    // 同一块同一位置连续编辑按停顿合并成一步
    this.withSnapshot('修改内容', node, `block:update:${node.id}:${input.index}`, () => {
      // 锁随模板来，不随写入方来：落库的档位一律以原块为准，免得被清掉
      node.contentBlocks[input.index] = { ...structuredClone(input.block), lock: existing.lock }
    })
  }

  importImage(input: ImageImportInput): { imagePath: string } {
    if (!existsSync(input.srcPath)) throw new ProjectServiceError('图片文件不存在')
    const node = this.requireNode(input.nodeId)
    const existing = node.contentBlocks[input.index]
    if (!existing || existing.type !== 'image') {
      throw new ProjectServiceError('目标不是图片块')
    }
    // 换图也是改内容：先拦下来，免得图片已经复制进工程目录却被拒绝
    if (existing.lock === 'readonly') {
      throw new ProjectServiceError(lockRefusal(existing.lock, 'edit'))
    }
    // 这里只把文件复制进工程目录，不动树，所以不入栈；
    // 换图真正落到树上是随后的 updateBlock，那一步自己带快照
    const ext = extname(input.srcPath).toLowerCase()
    const imageName = `${randomUUID()}${ext}`
    const imagesDir = join(this.projectDirValue, 'images')
    mkdirSync(imagesDir, { recursive: true })
    const target = join(imagesDir, imageName)
    copyFileSync(input.srcPath, target)
    // 记相对工程目录的路径：所有读图的地方都按工程目录解析（缩略图、预览、导出）
    return { imagePath: `images/${imageName}` }
  }

  /** 写工程内文件（图片/mermaid 缓存等）。relPath 必须落在工程目录内。 */
  writeProjectFile(input: FileWriteBytesInput): string {
    if (!this.isOpen) throw new ProjectServiceError('工程未打开')
    const resolved = resolve(this.projectDirValue, input.relPath)
    const rel = relative(this.projectDirValue, resolved)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new ProjectServiceError('非法路径：越出工程目录')
    }
    mkdirSync(dirname(resolved), { recursive: true })
    writeFileSync(resolved, Buffer.from(input.base64, 'base64'))
    return basename(resolved)
  }

  /** 读工程内文件为 dataURL（图片缩略图用）；文件不存在返回 null */
  readProjectFileDataUrl(relPath: string): string | null {
    if (!this.isOpen) throw new ProjectServiceError('工程未打开')
    const resolved = resolve(this.projectDirValue, relPath)
    const rel = relative(this.projectDirValue, resolved)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new ProjectServiceError('非法路径：越出工程目录')
    }
    // 兼容只记了文件名的历史数据：图片实际都放在工程 images/ 下
    const target = existsSync(resolved)
      ? resolved
      : isAbsolute(relPath)
        ? resolved
        : join(this.projectDirValue, 'images', relPath)
    if (!existsSync(target)) return null
    const mime = mimeOf(extname(target))
    const data = readFileSync(target)
    return `data:${mime};base64,${data.toString('base64')}`
  }

  // ================= 撤销与重做 =================

  /** 撤销最近一步：把该步的"改动前"子树写回，整树交回界面替换 */
  undo(): HistoryResultDto {
    const entry = this.history.undo()
    if (!entry) throw new ProjectServiceError('没有可撤销的编辑')
    return this.applyHistoryStep(entry.before)
  }

  /** 重做最近撤销的一步：写回该步的"改动后"子树 */
  redo(): HistoryResultDto {
    const entry = this.history.redo()
    if (!entry) throw new ProjectServiceError('没有可重做的编辑')
    return this.applyHistoryStep(entry.after)
  }

  /** 界面用：按钮置灰、悬停提示与历史列表（bytes 不给界面，只用于栈自己的上限） */
  historyState(): HistoryStateDto {
    const state = this.history.state()
    return {
      canUndo: state.canUndo,
      canRedo: state.canRedo,
      undoLabel: state.undoLabel,
      redoLabel: state.redoLabel,
      steps: state.steps,
      undoLabels: this.history.undoLabels(),
      redoLabels: this.history.redoLabels()
    }
  }

  /**
   * 跳到历史中的某一步：界面点历史列表里的某一条就走这里。
   * keep 是保留多少步已应用的编辑，界面会把越界值夹在 0 到总步数之间，这里再夹一次。
   */
  jump(input: HistoryJumpInput): HistoryResultDto {
    const total = this.history.undoLabels().length + this.history.redoLabels().length
    const keep = Math.max(0, Math.min(total, Math.trunc(input.keep)))
    let focusNodeId: string | null = null
    let guard = 0
    while (this.history.state().steps > keep && guard < 10000) {
      const entry = this.history.undo()
      if (!entry) break
      this.restoreSnapshot(entry.before)
      focusNodeId = entry.before.nodeId
      guard += 1
    }
    while (this.history.state().steps < keep && guard < 10000) {
      const entry = this.history.redo()
      if (!entry) break
      this.restoreSnapshot(entry.after)
      focusNodeId = entry.after.nodeId
      guard += 1
    }
    return { ...this.openResult(), history: this.historyState(), focusNodeId }
  }

  private applyHistoryStep(snapshot: TreeSnapshot): HistoryResultDto {
    this.restoreSnapshot(snapshot)
    return { ...this.openResult(), history: this.historyState(), focusNodeId: snapshot.nodeId }
  }

  /**
   * 写回一份子树快照。撤销按后进先出，所以快照覆盖的节点通常都还在；
   * 万一它已经不在了（栈上更早的步骤才把它删掉），退回根，至少不把这一步丢掉。
   */
  private restoreSnapshot(snapshot: TreeSnapshot): void {
    const tree = this.requireTree()
    const live = tree.nodeById(snapshot.nodeId) ?? tree.root
    live.restoreFrom(snapshot.node)
  }

  // ================= UI 状态 =================

  /**
   * 交付前检查：把"会影响到导出结果"的问题在预览里一次说清。
   * 只报真问题（缺图、转换组件不可用、表格超出界面上限），不做常规计数播报。
   */
  async precheck(): Promise<PrecheckResult> {
    const result: PrecheckResult = {
      images: { total: 0, missing: [] },
      mermaid: { total: 0, converterAvailable: true },
      tables: { total: 0, overLimit: 0 }
    }
    if (this.treeValue) {
      this.treeValue.traverse((n) => {
        for (const b of n.contentBlocks) {
          if (b.type === 'image') {
            result.images.total += 1
            if (b.imagePath && !this.imageExists(b.imagePath)) {
              result.images.missing.push(b.imagePath)
            }
          } else if (b.type === 'mermaid') {
            result.mermaid.total += 1
          } else if (b.type === 'table') {
            result.tables.total += 1
            const cols = Math.max(
              b.headers.length,
              b.cols,
              ...b.data.map((row) => row.length)
            )
            if (bodyRowCount(b.rows, b.data.length) > TABLE_MAX_ROWS || cols > TABLE_MAX_COLS) {
              result.tables.overLimit += 1
            }
          }
        }
      })
    }
    result.mermaid.converterAvailable = await isMermaidConversionAvailable()
    return result
  }

  /** 工程内图片是否真的在（与读图同一条回落规则：先按工程目录，再按 images/） */
  private imageExists(imagePath: string): boolean {
    const direct = isAbsolute(imagePath) ? imagePath : resolve(this.projectDirValue, imagePath)
    if (existsSync(direct)) return true
    if (isAbsolute(imagePath)) return false
    return existsSync(join(this.projectDirValue, 'images', imagePath))
  }

  /** 当前文档树中的 Mermaid 图块数（导出对话框提示/诊断） */
  countMermaidFigures(): number {
    if (!this.treeValue) return 0
    return collectMermaidFigures(this.treeValue).length
  }

  /**
   * 导出前的图表与表格统计。
   * 口径分三类：图片块（image）与 mmd-visio 块（mermaid）走的是两条嵌入链路——
   * 前者由 writer 直接嵌入，后者要经上游 mmd2vsdx 转成 Visio 对象；
   * 表格则是原生内容，由 writer 直接写成 Word 表格，不经过嵌入。
   * 只数 mermaid 会把"文档里有 131 张图、46 个表"说成"没有图表"。
   */
  async figureCounts(): Promise<{
    images: number
    mermaid: number
    mermaidAvailable: boolean
    tables: number
  }> {
    let images = 0
    let tables = 0
    if (this.treeValue) {
      this.treeValue.traverse((n) => {
        for (const b of n.contentBlocks) {
          if (b.type === 'image') images += 1
          else if (b.type === 'table') tables += 1
        }
      })
    }
    const mermaid = this.countMermaidFigures()
    return { images, mermaid, mermaidAvailable: await isMermaidConversionAvailable(), tables }
  }

  saveUiState(key: string, value: string): void {
    this.store.saveUiState(key, value)
  }

  loadUiState(key: string, defaultValue = ''): string {
    return this.store.loadUiState(key, defaultValue)
  }

  // ================= 导出 =================

  /** 先保存再导出 DOCX（样式按 uuid 查找；找不到这份样式就拒导出） */
  async exportDocx(input: ExportDocxInput): Promise<ExportDocxResult> {
    const tree = this.requireTree()
    const styleDef = this.managerValue.findStyleByUuid(input.styleUuid)
    if (!styleDef) {
      throw new ProjectServiceError('找不到这份样式模板，可能已经被删除')
    }
    // 导出前先落库，保证导出内容与当前编辑一致；落库即封口，与保存同一口径
    this.store.save(tree)
    this.history.seal()
    // 图块链路自动执行（无“占位/预览”用户选项）：Mermaid → VSDX → OLE 嵌入；
    // 预览 = 上游转换附带物（无则为无预览嵌入）；mmd2vsdx 不可用自动降级为文本占位 + 警告
    const withFigs = await exportTreeToDocxWithFigures(tree, styleDef, input.outputPath, {
      imageBaseDir: this.projectDirValue
    })
    return {
      outputPath: withFigs.outputPath,
      clonedGroups: withFigs.clonedGroups,
      paragraphCount: withFigs.instructions.length,
      warnings: withFigs.warnings,
      figures: withFigs.figureStats
    }
  }

  // ================= 内部 =================

  private requireTree(): DocumentTree {
    if (!this.treeValue) throw new ProjectServiceError('工程未打开')
    return this.treeValue
  }

  private requireNode(nodeId: string): DocumentNode {
    const node = this.requireTree().nodeById(nodeId)
    if (!node) throw new ProjectServiceError('找不到该章节，可能已被删除')
    return node
  }

  /**
   * 在快照包裹下执行一次树变更：入口留"改动前"，成功后留"改动后"，并入一步栈。
   * `scope` 是被改的那个节点（改子级名单的操作传父节点），`coalesceKey` 为 null 表示
   * 这一步不与任何步骤合并。action 抛错就原样抛出且不入栈——被拒绝的写入等于没发生。
   */
  private withSnapshot<T>(
    label: string,
    scope: DocumentNode,
    coalesceKey: string | null,
    action: () => T
  ): T {
    const before: TreeSnapshot = { nodeId: scope.id, node: scope.snapshot() }
    const result = action()
    const after: TreeSnapshot = { nodeId: scope.id, node: scope.snapshot() }
    this.history.push({ label, before, after, coalesceKey })
    return result
  }

  private assertBlocksAllowed(node: DocumentNode): void {
    if (!node.allowContentBlocks) {
      throw new ProjectServiceError('该章节不能添加内容')
    }
  }
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.emf': 'image/x-emf'
}

function mimeOf(ext: string): string {
  return IMAGE_MIME[ext.toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 模板锁里"必须存在"的两档：不能删、不能挪。`type` 档只锁类型，删除与移动照常。
 */
function isBlockPinned(lock: ContentBlock['lock']): lock is 'keep' | 'readonly' {
  return lock === 'keep' || lock === 'readonly'
}

/**
 * 写入侧拒绝时的说法，与界面上按钮置灰的提示同一口径：
 * 先讲模板的规定，再讲这件事做不了，不写"不可编辑"这类喊话式文案。
 */
function lockRefusal(lock: 'keep' | 'readonly', what: 'remove' | 'move' | 'edit'): string {
  if (what === 'edit') return '模板规定该内容为定稿，内容不能改'
  const head = lock === 'readonly' ? '模板规定该内容为定稿' : '模板规定该内容必须存在'
  return what === 'remove' ? `${head}，不能删除` : `${head}，不能移动`
}

/**
 * 表格形状校验：拦在写入侧。
 *
 * 以前没有任何校验，形状不一致要等到导出时被 `min(rows, data.length)` 掩盖过去，
 * 界面上完全看不出来（`rows` 写成"数据行 + 表头"就是这么混过去的）。
 * 现在把问题在写入时报出来，附上具体位置。
 */
function assertTableShape(block: ContentBlock): void {
  if (block.type !== 'table') return
  const issues = checkTableShape(block)
  if (issues.length === 0) return
  // rows 不一致只提示不拦（历史口径，且渲染只认 data）；列数不一致必须拦
  const blocking = issues.filter((i) => i.where !== 'rows')
  if (blocking.length > 0) {
    throw new ProjectServiceError(
      `表格形状不合法：${blocking.map((i) => `${i.where} —— ${i.reason}`).join('；')}`
    )
  }
  for (const i of issues) console.warn('[table]', i.where, i.reason)
}

/**
 * 上游 mmd2vsdx 的门面是否可用（只探测，不转换）。
 * 用于导出对话框提前告知：不可用时 mmd-visio 会按文本导出，而不是交付可双击的对象。
 * 不复用导出链路里的加载函数——那个会带上"安装指引"这类面向失败场景的长文案。
 */
async function isMermaidConversionAvailable(): Promise<boolean> {
  try {
    const mod = await import('mmd2vsdx')
    resolveMmdFacade(mod)
    return true
  } catch {
    return false
  }
}

/** 一个节点固有字段（级别/权限/复制组/子级名单）折算成的固定开销 */
const NODE_OVERHEAD_BYTES = 128

/**
 * 一条快照占多少字节：递归累加标题、编制说明与各内容块的长度。
 * 只逐块 stringify，不对整棵树 stringify（那样既慢，又会被 parent 环挡住）；
 * 目的是让栈的字节上限生效，量级对就够，不追求精确（中文按字符数算，偏低估）。
 */
function estimateSnapshotBytes(snapshot: TreeSnapshot): number {
  return estimateNodeBytes(snapshot.node)
}

function estimateNodeBytes(node: DocumentNode): number {
  let bytes = NODE_OVERHEAD_BYTES + node.title.length + node.description.length
  for (const block of node.contentBlocks) bytes += JSON.stringify(block).length
  for (const child of node.children) bytes += estimateNodeBytes(child)
  return bytes
}
