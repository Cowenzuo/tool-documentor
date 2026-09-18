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

export class ProjectService {
  private treeValue: DocumentTree | null = null
  private anchorValue: ProjectAnchor | null = null
  private projectDirValue = ''
  private store = new ProjectStore()
  private managerValue: TemplateManager

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
    const template = this.managerValue.findStructureByName(input.templateName)
    if (!template) {
      throw new ProjectServiceError(`未找到结构模板：${input.templateName}`)
    }

    mkdirSync(projectDir, { recursive: true })
    const tree = this.managerValue.instantiate(template)
    if (!tree) throw new ProjectServiceError('模板实例化失败')

    const dbPath = join(projectDir, 'documentor.db')
    this.store.create(dbPath, input.name, input.templateName)
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
      template: input.templateName,
      db_file: 'documentor.db',
      created_at: now,
      updated_at: now
    }
    writeAnchor(projectDir, anchor)

    this.treeValue = tree
    this.anchorValue = anchor
    this.projectDirValue = projectDir
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
    return this.openResult()
  }

  saveProject(): SaveResult {
    const tree = this.requireTree()
    this.store.save(tree)
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
  }

  projectInfo(): ProjectInfoDto {
    return {
      name: this.store.projectName(),
      templateName: this.store.templateName(),
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

  setNodeTitle(input: NodeTitleInput): void {
    const node = this.requireNode(input.nodeId)
    node.title = input.title
  }

  setNodeDescription(input: NodeDescriptionInput): void {
    const node = this.requireNode(input.nodeId)
    node.description = input.description
  }

  copyNode(input: NodeCopyInput): CopyNodeResult {
    const node = this.requireNode(input.nodeId)
    if (node.isRoot()) throw new ProjectServiceError('根章节不能复制')
    if (!node.copyable) throw new ProjectServiceError('该章节不允许复制')
    const parent = node.parent
    if (!parent) throw new ProjectServiceError('找不到上级章节')
    const clone = node.deepClone()
    const index = parent.children.indexOf(node) + 1
    parent.insertChildAt(index, clone)
    return { node: toNodeDto(clone), index }
  }

  deleteNode(input: NodeDeleteInput): void {
    const node = this.requireNode(input.nodeId)
    if (node.isRoot()) throw new ProjectServiceError('根章节不能删除')
    if (!node.deletable) throw new ProjectServiceError('该章节不允许删除')
    const parent = node.parent
    if (!parent) throw new ProjectServiceError('找不到上级章节')
    parent.removeChild(node)
  }

  /**
   * 当前工程的正文栏宽（twips），供预览按导出栏宽排版。
   * 取"结构模板可用样式里的第一套"——与导出对话框的默认选择一致；
   * 解析交给 docx 包的骨架解析函数，界面侧不另算一份。
   */
  pageTextWidthTwips(): number | null {
    if (!this.isOpen) return null
    const def = this.managerValue.findStructureByName(this.store.templateName())
    const candidates = def ? this.managerValue.styleCandidatesForStructure(def) : []
    const pick = candidates.find((c) => c.available) ?? candidates[0]
    if (!pick) return null
    const styleDef = this.managerValue.findStyleTemplate(pick.fileKey)
    if (!styleDef) return null
    return skeletonTextWidthTwips(styleDef.skeletonPath)
  }

  // ================= 内容块变更 =================
  addBlock(input: BlockAddInput): number {
    const node = this.requireNode(input.nodeId)
    this.assertBlocksAllowed(node)
    const block = createBlock(input.type)
    // 带 index 就是"插到这一项之前"，不带就追加到末尾
    if (typeof input.index === 'number') {
      node.insertContentBlock(input.index, block)
    } else {
      node.addContentBlock(block)
    }
    return node.contentBlocks.length
  }

  removeBlock(input: BlockIndexInput): number {
    const node = this.requireNode(input.nodeId)
    if (!node.removeContentBlockAt(input.index)) {
      throw new ProjectServiceError('内容位置不对，请刷新后重试')
    }
    return node.contentBlocks.length
  }

  moveBlock(input: BlockMoveInput): void {
    const node = this.requireNode(input.nodeId)
    node.swapContentBlocks(input.from, input.to)
  }

  updateBlock(input: BlockUpdateInput): void {
    const node = this.requireNode(input.nodeId)
    const existing = node.contentBlocks[input.index]
    if (!existing) throw new ProjectServiceError('内容位置不对，请刷新后重试')
    if (existing.type !== input.block.type) {
      throw new ProjectServiceError('内容类型不能直接改，请删除后重新添加')
    }
    assertTableShape(input.block)
    node.contentBlocks[input.index] = structuredClone(input.block)
  }

  importImage(input: ImageImportInput): { imagePath: string } {
    if (!existsSync(input.srcPath)) throw new ProjectServiceError('图片文件不存在')
    const node = this.requireNode(input.nodeId)
    const existing = node.contentBlocks[input.index]
    if (!existing || existing.type !== 'image') {
      throw new ProjectServiceError('目标不是图片块')
    }
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

  /** 先保存再导出 DOCX（样式模板按 fileKey 查找；软校验候选可用性） */
  async exportDocx(input: ExportDocxInput): Promise<ExportDocxResult> {
    const tree = this.requireTree()
    const def = this.managerValue.findStructureByName(this.store.templateName())
    const candidates = def ? this.managerValue.styleCandidatesForStructure(def) : []
    const target = candidates.find((c) => c.fileKey === input.styleFileKey)
    if (!target) {
      throw new ProjectServiceError(
        `样式模板「${input.styleFileKey}」不属于当前结构模板的可用集合`
      )
    }
    if (!target.available) {
      throw new ProjectServiceError(
        `样式模板「${target.name}」不可用于当前结构模板，缺少样式键：${target.missingKeys.join('、')}`
      )
    }
    const styleDef = this.managerValue.findStyleTemplate(input.styleFileKey)
    if (!styleDef) {
      throw new ProjectServiceError(`未找到样式模板：${input.styleFileKey}`)
    }
    // 导出前先落库，保证导出内容与当前编辑一致
    this.store.save(tree)
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
