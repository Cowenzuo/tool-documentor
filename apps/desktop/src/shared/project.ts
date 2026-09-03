/**
 * 工程 IPC 契约：main ⇄ renderer 的工程/树/块操作消息与 DTO。
 * 模型：main 进程持有权威文档树与 SQLite；renderer 持有树镜像，
 * 所有变更经此处命令在 main 校验后执行，返回局部结果（不整树回传）。
 */
import type { BlockTypeName, ContentBlock } from '@documentor/core/blocks'

export interface NodeDto {
  id: string
  headingLevel: number
  title: string
  description: string
  copyable: boolean
  deletable: boolean
  allowContentBlocks: boolean
  isSubTitle: boolean
  subTitleStyle: string
  subTitleAutoNumber: boolean
  copyGroupId: string
  allowedChildLevels: string[]
  contentBlocks: ContentBlock[]
  children: NodeDto[]
}

export interface ProjectInfoDto {
  name: string
  templateName: string
  projectDir: string
  dprojPath: string
}

export interface CreateProjectInput {
  /** 工作区目录（父目录） */
  workspaceDir: string
  /** 工程名（即目录名） */
  name: string
  /** 结构模板名称 */
  templateName: string
}

export interface ProjectOpenResult {
  info: ProjectInfoDto
  root: NodeDto
}

export interface SaveResult {
  savedAt: string
}

/** 树命令结果：复制节点后 renderer 需要新节点子树 */
export interface CopyNodeResult {
  node: NodeDto
  index: number
}

export interface BlockMutationResult {
  nodeId: string
  /** 变更后该节点的块数 */
  blockCount: number
}

export interface ImportImageResult {
  imagePath: string
}

export interface StructureTemplateDto {
  name: string
  category: string
  description: string
  version: string
  /** 关联的样式模板 fileKey（导出默认选择用） */
  styleFileKey: string
}

export interface StyleTemplateDto {
  name: string
  version: string
  description: string
  /** 可显示的标识（stylemap 文件名，不含 .json） */
  fileKey: string
}

/** 应用配置（userData/config.json） */
export interface AppConfigDto {
  version: number
  default_project_dir: string
  template_dirs: string[]
  recents: string[]
}

export interface UiStateSave {
  key: string
  value: string
}

// ---------- IPC 通道 ----------

export const ProjectIpc = {
  ProjectCreate: 'project:create',
  ProjectOpen: 'project:open',
  ProjectClose: 'project:close',
  ProjectSave: 'project:save',
  ProjectGetInfo: 'project:get-info',
  ProjectIsOpen: 'project:is-open',

  TreeGetRoot: 'tree:get-root',
  NodeUpdateTitle: 'node:update-title',
  NodeUpdateDescription: 'node:update-description',
  NodeCopy: 'node:copy',
  NodeDelete: 'node:delete',

  BlockAdd: 'block:add',
  BlockRemove: 'block:remove',
  BlockMove: 'block:move',
  BlockUpdate: 'block:update',
  ImageImport: 'image:import',
  /** 渲染进程生成的文件字节写盘（如 mermaid 缓存 PNG） */
  FileWriteBytes: 'file:write-bytes',
  /** 读取工程内文件为 dataURL（如图片缩略图） */
  FileReadDataUrl: 'file:read-data-url',

  UiStateSave: 'ui-state:save',
  UiStateLoad: 'ui-state:load',

  DialogSelectDproj: 'dialog:select-dproj',
  DialogSelectDirectory: 'dialog:select-directory',
  DialogSelectImage: 'dialog:select-image',

  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  TemplatesListStructures: 'templates:list-structures',
  TemplatesListStyles: 'templates:list-styles',
  /** 导出 DOCX */
  ExportDocx: 'export:docx',
  /** 另存对话框（导出路径） */
  DialogSavePath: 'dialog:save-path'
} as const

// ---------- 工具：消息 payload 类型 ----------

export interface NodeTitleInput {
  nodeId: string
  title: string
}

export interface NodeDescriptionInput {
  nodeId: string
  description: string
}

export interface NodeCopyInput {
  nodeId: string
}

export interface NodeDeleteInput {
  nodeId: string
}

export interface BlockAddInput {
  nodeId: string
  type: BlockTypeName
}

export interface BlockIndexInput {
  nodeId: string
  index: number
}

export interface BlockMoveInput {
  nodeId: string
  from: number
  to: number
}

export interface BlockUpdateInput {
  nodeId: string
  index: number
  block: ContentBlock
}

export interface ImageImportInput {
  nodeId: string
  index: number
  /** 源图片绝对路径 */
  srcPath: string
}

export interface FileWriteBytesInput {
  /** 相对工程目录的路径（如 mermaid/abc123.png） */
  relPath: string
  /** base64 编码的字节 */
  base64: string
}

export interface UiStateKeyInput {
  key: string
}

// ---------- renderer 可见的桌面桥 API ----------

export interface DesktopProjectApi {
  create(input: CreateProjectInput): Promise<ProjectOpenResult>
  open(dprojPath: string): Promise<ProjectOpenResult>
  close(): Promise<void>
  save(): Promise<SaveResult>
  isOpen(): Promise<boolean>
  getInfo(): Promise<ProjectInfoDto>
  treeGetRoot(): Promise<ProjectOpenResult>
}

export interface DesktopTreeApi {
  updateTitle(input: NodeTitleInput): Promise<void>
  updateDescription(input: NodeDescriptionInput): Promise<void>
  copy(input: NodeCopyInput): Promise<CopyNodeResult>
  delete(input: NodeDeleteInput): Promise<void>
}

export interface DesktopBlockApi {
  add(input: BlockAddInput): Promise<number>
  remove(input: BlockIndexInput): Promise<number>
  move(input: BlockMoveInput): Promise<void>
  update(input: BlockUpdateInput): Promise<void>
  importImage(input: ImageImportInput): Promise<ImportImageResult>
  writeBytes(input: FileWriteBytesInput): Promise<string>
}

export interface DesktopUiStateApi {
  save(key: string, value: string): Promise<void>
  load(key: string): Promise<string>
}

export interface DesktopDialogApi {
  selectDproj(): Promise<string | null>
  selectDirectory(): Promise<string | null>
  selectImage(): Promise<string | null>
  savePath(options: SavePathDialogOptions): Promise<string | null>
}

export interface DesktopFileApi {
  /** 工程内文件 → dataURL（不存在返回 null） */
  readAsDataUrl(relPath: string): Promise<string | null>
}

export interface DesktopSettingsApi {
  get(): Promise<AppConfigDto>
  set(patch: Partial<AppConfigDto>): Promise<void>
}

export interface DesktopTemplatesApi {
  listStructures(): Promise<StructureTemplateDto[]>
  listStyles(): Promise<StyleTemplateDto[]>
}

export interface ExportDocxInput {
  /** 样式模板 fileKey（stylemap 文件名） */
  styleFileKey: string
  outputPath: string
}

export interface ExportDocxResult {
  outputPath: string
  clonedGroups: number
  paragraphCount: number
}

export interface DesktopExportApi {
  docx(input: ExportDocxInput): Promise<ExportDocxResult>
}

export interface SavePathDialogOptions {
  defaultPath: string
}
