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

/** 结构 × 样式配对候选（软校验：不可用项带原因，导出入口据此收敛） */
export interface StyleCandidateDto {
  fileKey: string
  name: string
  version: string
  description: string
  available: boolean
  missingKeys: string[]
  isDefault: boolean
}

/** 应用配置（userData/config.json） */
export interface AppConfigDto {
  version: number
  default_project_dir: string
  template_dirs: string[]
  recents: string[]
}

/** 单个模板目录的加载结果（供设置界面与新建向导显示「为什么没加载到」） */
export interface TemplateDirReport {
  dir: string
  exists: boolean
  hasManifest: boolean
  structures: number
  styles: number
  /** 该目录一套都没加载到 */
  loadFailed: boolean
  /** 已经翻译成用户可读的原因；空数组表示没被跳过任何条目 */
  reasons: string[]
}

/** 模板加载总览 */
export interface TemplateLoadReport {
  dirs: TemplateDirReport[]
  structures: number
  styles: number
  loadedAny: boolean
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
  /** 结构模板的样式候选（1:N + 校验可用性） */
  TemplatesStyleCandidates: 'templates:style-candidates',
  /** 模板加载总览：配了哪些目录、各自加载到几套、没加载到的原因 */
  TemplatesDiagnose: 'templates:diagnose',
  /** 导出 DOCX */
  ExportDocx: 'export:docx',
  /** 导出前的图表统计：图片数 / 流程图数 / 流程图转换是否可用 */
  ExportFigureCounts: 'export:figure-counts',
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
  /** 结构模板的样式候选（含可用性校验） */
  styleCandidates(structureName: string): Promise<StyleCandidateDto[]>
  /** 模板加载总览：配了哪些目录、各自加载到几套、没加载到的原因 */
  diagnose(): Promise<TemplateLoadReport>
}

export type FigureEmbedMode = 'embed' | 'embed-preview'

export interface ExportFigureStats {
  /** 文档中 Mermaid 图块总数 */
  total: number
  /** 成功转成 vsdx 的数量 */
  converted: number
  /** 嵌入 docx 的对象数 */
  embedded: number
  /** 预览图（EMF/PNG）生成数 */
  previewCount: number
  /** 失败明细（题注 + 原因） */
  failed: Array<{ caption: string; reason: string }>
  /** 转换服务整体不可用（此时 failed 为空，但 total 张全都没嵌入） */
  unavailable?: boolean
}

export interface ExportDocxInput {
  /** 样式模板 fileKey（stylemap 文件名） */
  styleFileKey: string
  outputPath: string
}

/** 导出前统计：文档里有几张图片、几幅流程图，以及流程图转换能力是否可用 */
export interface FigureCountsDto {
  /** image 块数：导出时直接嵌入，不依赖上游 */
  images: number
  /** mermaid 块数：需经上游转成 Visio 对象 */
  mermaid: number
  /** 上游 mmd2vsdx 门面是否可用；false 时流程图会降级为文本导出 */
  mermaidAvailable: boolean
}

export interface ExportDocxResult {
  outputPath: string
  clonedGroups: number
  paragraphCount: number
  /** 样式键缺失/嵌入降级等明细（透明化兜底） */
  warnings: string[]
  /** 图嵌入统计（图块链路自动执行；无图块时 total=0） */
  figures?: ExportFigureStats
}

export interface DesktopExportApi {
  docx(input: ExportDocxInput): Promise<ExportDocxResult>
  /** 导出前的图表统计（未打开工程时全 0） */
  figureCounts(): Promise<FigureCountsDto>
}

export interface SavePathDialogOptions {
  defaultPath: string
}
