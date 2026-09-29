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
import { blockPermissions, lockRefusal, reshapeRefusal } from '../../shared/permissionTerms'
import { exportTreeToDocxWithFigures, collectMermaidFigures, skeletonTextWidthTwips } from '@documentor/docx'
import type { FigureConvertFn } from '@documentor/docx'
import type { MmdService } from './mmd-service'
import type { VisioService } from './visio-service'
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
  /** 图转换服务客户端（mmd2vsdx，本机常驻 HTTP 服务）；没给就当转换不可用，整篇文本导出 */
  private readonly mmdValue: MmdService | undefined
  /**
   * Visio（可选加速器）；没给 = 不归一化。
   * 有则导出前把整批 vsdx 过一遍 Visio（重存 + 导出预览），首帧由 Visio 自己的解保证；
   * 没装 Visio 时首帧问题按既定口径**接受**（详见 docs/WORD处理经验/10）。
   */
  private readonly visioValue: VisioService | undefined
  /** 会话级撤销栈：跟着当前打开的工程走，开关工程时清空 */
  private readonly history = new HistoryStack<TreeSnapshot>({
    maxSteps: HISTORY_MAX_STEPS,
    maxBytes: HISTORY_MAX_BYTES,
    measure: estimateSnapshotBytes
  })

  constructor(manager: TemplateManager, mmd?: MmdService, visio?: VisioService) {
    this.managerValue = manager
    this.mmdValue = mmd
    this.visioValue = visio
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
      throw new ProjectServiceError(`工程文件无效：${dprojPath}`)
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
      // 读库失败（工程数据损坏）照原话说出去：用户要拿着这句话去查是哪一块坏了
      const why = err instanceof Error ? err.message : String(err)
      throw new ProjectServiceError(`工程加载失败：${why}`)
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
   * 老工程（改用 uuid 之前）库里与锚点里只有模板名，按名字认一次 uuid —— 认到就换过来记，
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
    if (!parent) throw new ProjectServiceError('未找到上级章节')
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
    // 节点级的删叫「裁剪」：与模板编辑器那个开关、界面上的标签同一个词（见 shared/permissionTerms）
    if (node.isRoot()) throw new ProjectServiceError('根章节不能裁剪')
    if (!node.deletable) throw new ProjectServiceError('该章节不允许裁剪')
    // 能不能裁只看这一个开关：块档位管的是块自己的改与删，不否决章节级动作。
    // 作者要护住整章，就把裁剪关掉（缺省就是关的）
    const parent = node.parent
    if (!parent) throw new ProjectServiceError('未找到上级章节')
    // 同复制：动的是父节点的子级名单，快照存父节点
    this.withSnapshot('裁剪章节', parent, null, () => {
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
  // 每一处写入都先过 blockPermissions（编辑 × 排版，见 shared/permissionTerms），拒绝语说清是哪一条挡的
  addBlock(input: BlockAddInput): number {
    const node = this.requireNode(input.nodeId)
    const perms = blockPermissions(node)
    if (!perms.add) throw new ProjectServiceError(perms.whyAdd)
    const block = createBlock(input.type)
    return this.withSnapshot('添加内容', node, null, () => {
      // 带 index 就是"插到这一项之前"，不带就追加到末尾。
      // 插在前面等于把后面的块往后挤：位置现在归「排版」管，排版开就允许
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
    const perms = blockPermissions(node)
    if (!perms.remove) throw new ProjectServiceError(perms.whyRemove)
    const existing = node.contentBlocks[input.index]
    if (!existing) throw new ProjectServiceError('内容位置错误，请刷新后重试')
    // 锁在这里也要拦一道：界面按档位置灰只是提示，写入侧才是最后一道
    if (isBlockPinned(existing.lock)) {
      throw new ProjectServiceError(lockRefusal(existing.lock, 'remove'))
    }
    return this.withSnapshot('删除内容', node, null, () => {
      if (!node.removeContentBlockAt(input.index)) {
        throw new ProjectServiceError('内容位置错误，请刷新后重试')
      }
      return node.contentBlocks.length
    })
  }

  moveBlock(input: BlockMoveInput): void {
    const node = this.requireNode(input.nodeId)
    const perms = blockPermissions(node)
    if (!perms.move) throw new ProjectServiceError(perms.whyMove)
    const from = node.contentBlocks[input.from]
    const to = node.contentBlocks[input.to]
    if (!from || !to) throw new ProjectServiceError('内容位置错误，请刷新后重试')
    // 位置归「排版」管：块档位不再管顺序，keep 块排版开着也挪得动
    this.withSnapshot('移动内容', node, null, () => {
      node.swapContentBlocks(input.from, input.to)
    })
  }

  updateBlock(input: BlockUpdateInput): void {
    const node = this.requireNode(input.nodeId)
    const perms = blockPermissions(node)
    if (!perms.editContent) throw new ProjectServiceError(perms.whyEditContent)
    const existing = node.contentBlocks[input.index]
    if (!existing) throw new ProjectServiceError('内容位置错误，请刷新后重试')
    // 只读档连内容都不能改；换类型与表头另按形状那一关看
    if (existing.lock === 'readonly') {
      throw new ProjectServiceError(lockRefusal(existing.lock, 'edit'))
    }
    // 换形状要两条都成立：这一章的排版开着，且块上没有锁（类型限制编辑与只读都不让换）
    const reshapable = perms.reshape && existing.lock === undefined
    if (existing.type !== input.block.type) {
      // 换类型：写回时按新类型整块替换
      if (!reshapable) throw new ProjectServiceError(reshapeRefusal(existing.lock, perms))
    } else if (tableShapeChanged(existing, input.block)) {
      // 表头与列数算形状，不算内容
      if (!reshapable) throw new ProjectServiceError(reshapeRefusal(existing.lock, perms))
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
    const perms = blockPermissions(node)
    if (!perms.editContent) throw new ProjectServiceError(perms.whyEditContent)
    const existing = node.contentBlocks[input.index]
    if (!existing || existing.type !== 'image') {
      throw new ProjectServiceError('目标内容不是图片')
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
      throw new ProjectServiceError('路径非法：超出工程目录')
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
      throw new ProjectServiceError('路径非法：超出工程目录')
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
    if (!entry) throw new ProjectServiceError('无可撤销编辑')
    return this.applyHistoryStep(entry.before)
  }

  /** 重做最近撤销的一步：写回该步的"改动后"子树 */
  redo(): HistoryResultDto {
    const entry = this.history.redo()
    if (!entry) throw new ProjectServiceError('无可重做编辑')
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
    result.mermaid.converterAvailable = await this.mermaidAvailable()
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
    return { images, mermaid, mermaidAvailable: await this.mermaidAvailable(), tables }
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
      throw new ProjectServiceError('未找到该样式模板')
    }
    // 导出前先落库，保证导出内容与当前编辑一致；落库即封口，与保存同一口径
    this.store.save(tree)
    this.history.seal()
    // 图块链路自动执行（无“占位/预览”用户选项）：Mermaid → VSDX → （可选）Visio 归一化 → OLE 嵌入；
    // 转换走本机常驻 HTTP 服务（mmd2vsdx），服务不可用时整篇降级为文本占位 + 警告
    const pre = await this.normalizeFiguresWithVisio(tree)
    const convert = this.figureConvert(pre.byCode)
    const withFigs = await exportTreeToDocxWithFigures(tree, styleDef, input.outputPath, {
      imageBaseDir: this.projectDirValue,
      ...(convert ? { convert } : {})
    })
    return {
      outputPath: withFigs.outputPath,
      clonedGroups: withFigs.clonedGroups,
      paragraphCount: withFigs.instructions.length,
      warnings: [...withFigs.warnings, ...pre.warnings],
      figures: withFigs.figureStats
    }
  }

  /**
   * 导出前把整批图过一遍 Visio（可选）。
   *
   * 为什么要预批量：Visio 启动一次就是秒级，逐张调 23 张图会慢到不可接受；
   * 这里先自己把 mermaid 全部转成 vsdx，再交给**一次** Visio 会话，转换函数随后只查表。
   *
   * 边界（三条，别越）：
   *   1. **没装 Visio / 没启用 / 中途失败** ⇒ 返回空表，一切照旧走原路径（首帧问题按既定口径接受）；
   *   2. 单张失败只影响那一张（其余仍用 Visio 的结果），失败缘由并进导出警告；
   *   3. 只有 Visio 的产出仍然要过预览护栏 —— 不合规就退回自产预览（EMF 那套硬约束见 07/08）。
   */
  private async normalizeFiguresWithVisio(tree: DocumentTree): Promise<{
    byCode: Map<string, { vsdxBase64: string; previewBase64?: string; previewTrusted?: boolean }>
    warnings: string[]
  }> {
    const empty = { byCode: new Map(), warnings: [] as string[] }
    const visio = this.visioValue
    const mmd = this.mmdValue
    if (!visio || !mmd) return empty
    if (!visio.isEnabled()) return empty

    const codes = collectMermaidFigures(tree).map((f) => f.code)
    if (codes.length === 0) return empty
    // 同一段 mermaid 在文中可能重复出现：Visio 只处理**唯一**的那几段（重复的查表即可）
    const uniqueCodes = [...new Set(codes)]

    // 先把 mermaid 全部转成 vsdx（失败的那几张不参与归一化，交给转换函数照旧报错）
    const items: Array<{ id: string; vsdx: Uint8Array }> = []
    const codeById = new Map<string, string>()
    for (const [i, code] of uniqueCodes.entries()) {
      const r = await mmd.convert(code)
      if (!r.ok) continue
      const id = `f${i}`
      items.push({ id, vsdx: r.bytes })
      codeById.set(id, code)
    }
    if (items.length === 0) return empty

    const results = await visio.normalizeBatch(items)
    const byCode = new Map<string, { vsdxBase64: string; previewBase64?: string; previewTrusted?: boolean }>()
    const warnings: string[] = []
    let failed = 0
    for (const r of results) {
      const code = codeById.get(r.id)
      if (!code) continue
      if (!r.ok || !r.vsdx) {
        failed += 1
        if (r.reason) console.warn(`[visio] 归一化失败，按原样嵌入：${r.reason}`)
        continue
      }
      // 口径：**走 Visio 就整套都用 Visio 的** —— vsdx 用重存件，预览用 Visio 导出的真图
      // （本机物理 dpi 是它的正常形态，previewTrusted 让它跳过 dpi 区间告警）。
      // 不走 Visio 的图这里根本没有 preview，由嵌入层自产。
      const previewBase64 = r.previewEmf ? Buffer.from(r.previewEmf).toString('base64') : undefined
      byCode.set(code, {
        vsdxBase64: Buffer.from(r.vsdx).toString('base64'),
        ...(previewBase64 ? { previewBase64, previewTrusted: true } : {})
      })
    }
    if (failed > 0) warnings.push(`Visio 归一化：${failed} 张未成功，已按原样嵌入（详见日志）`)
    return { byCode, warnings }
  }

  // ================= 内部 =================

  /**
   * 图转换服务是否可用（弱确认，带短缓存）。
   * 导出对话框会反复问，不能每次都打一次 /health；真导出时走的是新鲜探测。
   */
  private async mermaidAvailable(): Promise<boolean> {
    if (!this.mmdValue) return false
    return this.mmdValue.available()
  }

  /**
   * 把 HTTP 客户端适配成 docx 库认的转换函数。
   *
   * 约定（DESIGN-07 的"与库的接口"一节，别改）：
   *   - 单张失败 → `{ ok:false }`：记进 failed，继续下一张；
   *   - 服务整体不可用 → `{ ok:false, unavailable:true }`：库立刻停手、整篇文本版交付。
   * docx 库不认 HTTP 状态码，也不认上游错误码——判定全在客户端。
   *
   * `preNormalized` 是导出前那次 Visio 归一化的结果（可选）：命中就直接用，
   * 顺手带上 Visio 导出的预览件；没命中（重复图、或没走 Visio）就照旧问转换服务。
   */
  private figureConvert(preNormalized?: Map<string, { vsdxBase64: string; previewBase64?: string }>): FigureConvertFn | undefined {
    const mmd = this.mmdValue
    if (!mmd) return undefined
    return async (code) => {
      // Visio 预归一化过的那批直接查表（表里的预览件已过护栏，过不了的不带 previewBase64，
      // 由嵌入层自产 —— 那套硬约束见 docs/WORD处理经验/07、08）
      const pre = preNormalized?.get(code)
      if (pre) return { ok: true, vsdxBase64: pre.vsdxBase64, ...(pre.previewBase64 ? { previewBase64: pre.previewBase64 } : {}) }
      const r = await mmd.convert(code)
      if (r.ok) {
        return { ok: true, vsdxBase64: Buffer.from(r.bytes).toString('base64') }
      }
      return { ok: false, error: r.message, unavailable: r.kind === 'unavailable' }
    }
  }

  private requireTree(): DocumentTree {
    if (!this.treeValue) throw new ProjectServiceError('工程未打开')
    return this.treeValue
  }

  private requireNode(nodeId: string): DocumentNode {
    const node = this.requireTree().nodeById(nodeId)
    if (!node) throw new ProjectServiceError('未找到该章节')
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
 * 模板锁里"必须存在"的两档：不能删。旧档位 `type` 与自由块照常删。
 * 位置不在这里判：那由节点级的「排版」管（见 `blockPermissions` 的 `move`）。
 */
function isBlockPinned(lock: ContentBlock['lock']): lock is 'keep' | 'readonly' {
  return lock === 'keep' || lock === 'readonly'
}

/** 表格形状（表头、列数、合并）动没动：这几项算形状，不算内容 */
function tableShapeChanged(existing: ContentBlock, incoming: ContentBlock): boolean {
  if (existing.type !== 'table' || incoming.type !== 'table') return false
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
  return (
    existing.cols !== incoming.cols ||
    !same(existing.headers, incoming.headers) ||
    !same(existing.rowSpans, incoming.rowSpans) ||
    (existing.mergeVertical === true) !== (incoming.mergeVertical === true)
  )
}

/**
 * 表格形状校验：拦在写入侧。
 *
 * 以前没有任何校验，形状不一致要等到导出时被 `min(rows, data.length)` 掩盖过去，
 * 界面上完全看不出来（`rows` 写成"数据行 + 表头"就是这么混过去的）。
 * 现在把问题在写入时报出来，附上具体位置。
 */

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

/** 一个节点固有字段（级别/权限/子级名单）折算成的固定开销 */
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
