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
  /**
   * 打开工程时读到的非致命问题，目前只有"内容块类型无法识别，已跳过"。
   * 这些块不会进界面，界面必须把警告弹给用户，否则下一次保存会把它们永久丢掉。
   */
  warnings?: string[]
}

export interface SaveResult {
  savedAt: string
}

/** 撤销栈的界面状态：按钮置灰、悬停提示与历史列表都用它 */
export interface HistoryStateDto {
  canUndo: boolean
  canRedo: boolean
  /** 最近一步可撤销动作的名字，栈空为 null */
  undoLabel: string | null
  redoLabel: string | null
  steps: number
  /** 已应用的步骤名，旧到新；界面倒序显示，最近一步在最上面 */
  undoLabels: string[]
  /** 已撤销的步骤名，下一个要重做的排在最前 */
  redoLabels: string[]
}

/** 跳到历史中的某一步：keep = 保留多少步已应用的编辑，0 表示回到最初 */
export interface HistoryJumpInput {
  keep: number
}

/** 撤销与重做的返回：与打开工程同形状，界面整棵替换 */
export interface HistoryResultDto extends ProjectOpenResult {
  history: HistoryStateDto
  /** 这一步动的章节 id，界面选中的章节若已不存在就退到它 */
  focusNodeId: string | null
}

/** 交付前检查：只报会影响导出结果的问题 */
export interface PrecheckResult {
  images: { total: number; missing: string[] }
  mermaid: { total: number; converterAvailable: boolean }
  tables: { total: number; overLimit: number }
}

/** 关闭前自动保存的结果：失败时工程保持打开，由调用方决定怎么提醒用户 */
export type SaveAndCloseResult = { ok: true } | { ok: false; error: string }

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
  /**
   * 加载了但有可疑之处的条目（一句一条）：块类型不认识、lock 取值不认识、
   * 样式骨架缺关系表部件等。与 reasons 分开，是因为这些条目本身是加载成功的。
   */
  warnings: string[]
}

/** 模板加载总览 */
export interface TemplateLoadReport {
  dirs: TemplateDirReport[]
  structures: number
  styles: number
  loadedAny: boolean
}

// ---------- 模板编辑（PLAN-11）----------

/** 一条校验结论：level 决定阻断与否，rule 是规则 id，path 指到具体节点或字段 */
export interface TemplateIssueDto {
  level: 'error' | 'warn'
  rule: string
  path: string
  message: string
}

/** 列表里的一份模板 */
export interface TemplateEntryDto {
  kind: 'structure' | 'style'
  /** 目录里的模板 id（目录名），读写都按它定位 */
  id: string
  /** 模板 JSON 里的 name，给人看的 */
  name: string
  /** manifest 里登记的文件名 */
  file: string
  errors: number
  warnings: number
  issues: TemplateIssueDto[]
}

/** 一个模板目录的现状 */
export interface TemplateDirSnapshotDto {
  dir: string
  exists: boolean
  /** 目录级问题：manifest 缺失或解析失败、目录不存在、有目录没登记等 */
  issues: TemplateIssueDto[]
  structures: TemplateEntryDto[]
  styles: TemplateEntryDto[]
}

/** 打开编辑模式时的全貌 */
export interface TemplateEditorSnapshotDto {
  /** 应用设置里在用的模板目录，编辑模式默认打开它；没配就是 null */
  defaultDir: string | null
  dirs: TemplateDirSnapshotDto[]
}

export interface TemplateReadInput {
  dir: string
  id: string
}

/** 读一份结构模板：doc 是解析后的原文，界面按字段编辑，没认得的字段原样保留 */
export interface TemplateReadResult {
  dir: string
  id: string
  file: string
  doc: Record<string, unknown>
  issues: TemplateIssueDto[]
}

export interface TemplateSaveInput {
  dir: string
  id: string
  doc: Record<string, unknown>
}

export interface TemplateSaveResult {
  savedAt: string
  /** 写前备份的路径；首次保存没有可备份的原文件时为 null */
  backupPath: string | null
  issues: TemplateIssueDto[]
}

export interface TemplateCreateInput {
  dir: string
  /** 目录名，也是模板 id；必须是合法目录名且不重复 */
  id: string
  /** 结构模板 JSON 的 name */
  name: string
  /** 默认配对哪份样式模板（stylemap 的 fileKey），可空 */
  styleTemplate?: string
}

export interface TemplateDeleteInput {
  dir: string
  id: string
}

export interface TemplateDeleteResult {
  /** 删除前整份目录备份到哪了 */
  backupPath: string
}

export interface TemplateRenameInput {
  dir: string
  /** 改之前的 id（目录名） */
  id: string
  /**
   * 新 id：目录名、`<id>-structure.json` 文件名与 manifest 里那条登记一起改。
   * 不带或与原值相同就只改 name。工程侧不存 id，所以改 id 不影响已建工程；
   * 但 name 是工程锚点认模板的依据，改 name 会让老工程配不上模板。
   */
  newId?: string
  /** 结构模板 JSON 里的 name（显示名） */
  name: string
}

export interface TemplateRenameResult extends TemplateReadResult {
  /** 改动前的备份：改 id 时是整份目录，只改 name 时是单个文件；都没有则为 null */
  backupPath: string | null
}

// ---------- 样式对照表（PLAN-11 批次 3）----------

/** 骨架里的一条样式：对照表下拉的选项（来源 `word/styles.xml`） */
export interface SkeletonStyleDto {
  /** `w:styleId`，styleMap 的值引用的就是它 */
  styleId: string
  /** `w:name`，Word 界面上的样式名（如「标题 1」）；没写是空串 */
  name: string
  /** paragraph 段落 / character 字符 / table / numbering；没写是空串 */
  type: string
  isDefault: boolean
  basedOn?: string
  /** 字号（磅，由 `w:sz` 的半磅换算） */
  fontSizePt?: number
  /** 样式自带多级列表编号（题注 auto 模式的号来自它） */
  numbered?: boolean
}

/** 对照表的一行：一个逻辑键 */
export interface StyleMapRowDto {
  key: string
  /** 分区（标题 / 列表子标题 / 正文 / 表格 / 图片 / 列表 / 其他），界面按它分组 */
  group: string
  /** 用途：这一行管哪些内容的样式 */
  usage: string
  /** 程序读不读这个键；false = 配了不生效（列表的第 2/3 档） */
  read: boolean
  /** 当前指向的 styleId（空串 = 没配这一行） */
  styleId: string
  /** 需要它的结构模板名（去重）；空数组 = 这份对照表里没人需要它 */
  requiredBy: string[]
  required: boolean
  /** ok 正常 / missing 必需但没配 / dangling 指向的样式不在骨架里 / inert 配了不生效 / unset 没配 / unchecked 骨架没读到没核对 */
  status: 'ok' | 'missing' | 'dangling' | 'inert' | 'unset' | 'unchecked'
  /** 一句话结论（直接展示） */
  message: string
  /** 没配时程序回退用哪个逻辑键；null = 按 Word 默认样式输出 */
  fallback: string | null
}

export interface TemplateStyleReadInput {
  dir: string
  id: string
}

/**
 * 读一份样式模板：stylemap 原文（界面按字段改，没认得的字段原样保留）、
 * 骨架里的样式表（下拉的选项）、按**引用它的结构模板**算出的对照表，
 * 以及这份对照表被哪些结构模板共用（改它之前要知道影响面）。
 */
export interface TemplateStyleReadResult {
  dir: string
  id: string
  /** manifest 登记的 stylemap 文件名 */
  file: string
  /** 结构模板引用它时写的 key：stylemap 文件名去掉 `.json` */
  fileKey: string
  doc: Record<string, unknown>
  /** 骨架目录绝对路径（`docxFolder` 拼出来的；不看它存不存在） */
  skeletonPath: string
  skeletonExists: boolean
  /** 骨架里的样式表；读不到是空表 */
  skeletonStyles: SkeletonStyleDto[]
  /** 骨架里有、这份对照表没人用的 styleId（顺便看看有没有漏配） */
  unusedStyleIds: string[]
  /** 对照表：认得的逻辑键全在，外加文件里多出来的键 */
  rows: StyleMapRowDto[]
  /** 哪些结构模板引用这份对照表 */
  usedBy: Array<{ id: string; name: string; isDefault: boolean }>
  issues: TemplateIssueDto[]
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
  /** 在系统文件管理器里打开当前工程目录 */
  ProjectRevealFolder: 'project:reveal-folder',
  /** 当前工程的正文栏宽（twips），预览按它排版 */
  ProjectPageTextWidth: 'project:page-text-width',
  /** 交付前检查：缺图、转换组件可用性、超限表格 */
  ProjectPrecheck: 'project:precheck',

  TreeGetRoot: 'tree:get-root',
  /** 撤销与重做：会话级历史，返回与打开工程同形状的载荷 */
  HistoryUndo: 'history:undo',
  HistoryRedo: 'history:redo',
  HistoryState: 'history:state',
  /** 跳到历史中的某一步 */
  HistoryJump: 'history:jump',
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
  /** 模板编辑：打开时的全貌（目录、模板、问题徽标） */
  TemplateSnapshot: 'template:snapshot',
  /** 模板编辑：读一份结构模板原文 */
  TemplateRead: 'template:read',
  /** 模板编辑：读一份样式模板（stylemap 原文 + 骨架样式表 + 对照表） */
  TemplateReadStyle: 'template:read-style',
  /** 模板编辑：写回结构模板（原子写 + .bak），写入前必须零 error */
  TemplateSave: 'template:save',
  /** 模板编辑：新建结构模板并同步 manifest */
  TemplateCreate: 'template:create',
  /** 模板编辑：删除结构模板（整份目录先备份） */
  TemplateDelete: 'template:delete',
  /** 模板编辑：改结构模板的名字 */
  TemplateRename: 'template:rename',
  /** 导出 DOCX */
  ExportDocx: 'export:docx',
  /** 导出前的图表与表格统计 */
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
  /** 插到第几项之前；不传就追加到末尾 */
  index?: number
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
  /** 在系统文件管理器里打开工程目录，返回该目录路径 */
  revealFolder(): Promise<string>
  /** 当前工程的正文栏宽（twips）；解析不到返回 null，界面用兜底宽度 */
  pageTextWidth(): Promise<number | null>
  /** 交付前检查：缺图、转换组件可用性、超限表格 */
  precheck(): Promise<PrecheckResult>
}

export interface DesktopTreeApi {
  updateTitle(input: NodeTitleInput): Promise<void>
  updateDescription(input: NodeDescriptionInput): Promise<void>
  copy(input: NodeCopyInput): Promise<CopyNodeResult>
  delete(input: NodeDeleteInput): Promise<void>
}

/** 撤销与重做：栈是会话级的，跟当前打开的工程走 */
export interface DesktopHistoryApi {
  undo(): Promise<HistoryResultDto>
  redo(): Promise<HistoryResultDto>
  state(): Promise<HistoryStateDto>
  /** 跳到第 keep 步之后的状态，0 表示回到最初 */
  jump(input: HistoryJumpInput): Promise<HistoryResultDto>
}

export interface DesktopBlockApi {
  add(input: BlockAddInput): Promise<number>
  remove(input: BlockIndexInput): Promise<number>
  move(input: BlockMoveInput): Promise<void>
  update(input: BlockUpdateInput): Promise<void>
  importImage(input: ImageImportInput): Promise<ImportImageResult>
  writeBytes(input: FileWriteBytesInput): Promise<string>
}

/**
 * 模板编辑（PLAN-11）：只动模板目录里的 JSON，不碰工程库、不进撤销栈。
 * 结构模板可读可写；样式模板可读，对照表（styleMap 与 captionNumbering）可写（批次 3）。
 */
export interface DesktopTemplateEditorApi {
  snapshot(): Promise<TemplateEditorSnapshotDto>
  read(input: TemplateReadInput): Promise<TemplateReadResult>
  readStyle(input: TemplateStyleReadInput): Promise<TemplateStyleReadResult>
  save(input: TemplateSaveInput): Promise<TemplateSaveResult>
  create(input: TemplateCreateInput): Promise<TemplateReadResult>
  remove(input: TemplateDeleteInput): Promise<TemplateDeleteResult>
  rename(input: TemplateRenameInput): Promise<TemplateRenameResult>
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

/**
 * 导出前统计。
 * 口径分三类：图片与 mmd-visio 是"要嵌入的对象"（后者依赖上游转换），
 * 表格是原生内容——由 writer 直接写成 Word 表格，不经过任何嵌入链路。
 */
export interface FigureCountsDto {
  /** image 块数：导出时直接嵌入，不依赖上游 */
  images: number
  /** mermaid 块数（mmd-visio）：需经上游转成 Visio 对象 */
  mermaid: number
  /** 上游 mmd2vsdx 门面是否可用；false 时 mmd-visio 会降级为文本导出 */
  mermaidAvailable: boolean
  /** table 块数：导出为原生 Word 表格 */
  tables: number
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
