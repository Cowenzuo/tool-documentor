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
  dbPathOf,
  localIsoNow,
  ProjectStore,
  readAnchor,
  writeAnchor,
  ANCHOR_FILE_NAME,
  type ProjectAnchor
} from '@documentor/core'
import type { DocumentTree, DocumentNode } from '@documentor/core/tree'
import { createBlock, type BlockTypeName, type ContentBlock } from '@documentor/core/blocks'
import { exportTreeToDocxWithFigures, collectMermaidFigures } from '@documentor/docx'
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

  createProject(input: CreateProjectInput): ProjectOpenResult {
    if (this.isOpen) this.closeProject()

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
    if (this.isOpen) this.closeProject()
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

  /** 保存并关闭（切换工程/退出前） */
  saveAndCloseProject(): void {
    if (this.isOpen) {
      try {
        this.saveProject()
      } catch (err) {
        console.error('[project] auto-save failed:', err)
      }
      this.closeProject()
    }
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
    return { info: this.projectInfo(), root: toNodeDto(root) }
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
    if (node.isRoot()) throw new ProjectServiceError('根节点不可复制')
    if (!node.copyable) throw new ProjectServiceError('该节点不允许复制')
    const parent = node.parent
    if (!parent) throw new ProjectServiceError('节点无父节点')
    const clone = node.deepClone()
    const index = parent.children.indexOf(node) + 1
    parent.insertChildAt(index, clone)
    return { node: toNodeDto(clone), index }
  }

  deleteNode(input: NodeDeleteInput): void {
    const node = this.requireNode(input.nodeId)
    if (node.isRoot()) throw new ProjectServiceError('根节点不可删除')
    if (!node.deletable) throw new ProjectServiceError('该节点不允许删除')
    const parent = node.parent
    if (!parent) throw new ProjectServiceError('节点无父节点')
    parent.removeChild(node)
  }

  // ================= 内容块变更 =================

  addBlock(input: BlockAddInput): number {
    const node = this.requireNode(input.nodeId)
    this.assertBlocksAllowed(node)
    node.addContentBlock(createBlock(input.type))
    return node.contentBlocks.length
  }

  removeBlock(input: BlockIndexInput): number {
    const node = this.requireNode(input.nodeId)
    if (!node.removeContentBlockAt(input.index)) {
      throw new ProjectServiceError('内容块索引越界')
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
    if (!existing) throw new ProjectServiceError('内容块索引越界')
    if (existing.type !== input.block.type) {
      throw new ProjectServiceError('内容块类型不可变更（请删除后重新添加）')
    }
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
    return { imagePath: imageName }
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
    if (!existsSync(resolved)) return null
    const mime = mimeOf(extname(resolved))
    const data = readFileSync(resolved)
    return `data:${mime};base64,${data.toString('base64')}`
  }

  // ================= UI 状态 =================

  /** 当前文档树中的 Mermaid 图块数（导出对话框提示/诊断） */
  countMermaidFigures(): number {
    if (!this.treeValue) return 0
    return collectMermaidFigures(this.treeValue).length
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
    if (!node) throw new ProjectServiceError(`节点不存在：${nodeId}`)
    return node
  }

  private assertBlocksAllowed(node: DocumentNode): void {
    if (!node.allowContentBlocks) {
      throw new ProjectServiceError('该节点不允许内容块')
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
