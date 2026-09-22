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
  /** 排版：块集合、顺序、类型能不能动；关掉后只能改各块的内容（DESIGN-06） */
  allowLayoutEdit: boolean
  isSubTitle: boolean
  subTitleStyle: string
  subTitleAutoNumber: boolean
  allowedChildLevels: string[]
  contentBlocks: ContentBlock[]
  children: NodeDto[]
}

export interface ProjectInfoDto {
  name: string
  /** 这份工程用的结构模板 uuid；找不到时为空串 */
  templateUuid: string
  /** 结构模板的展示名，只给人看；模板没了就是空串 */
  templateName: string
  /**
   * 老工程（改用 uuid 之前）只记了模板名、又没认成 uuid 时，这里带出那个名字；
   * 认到了或本来就是新工程则为空串。界面用它说明"是哪一份模板没认到"。
   */
  legacyTemplateName: string
  projectDir: string
  dprojPath: string
}

export interface CreateProjectInput {
  /** 工作区目录（父目录） */
  workspaceDir: string
  /** 工程名（即目录名） */
  name: string
  /** 结构模板 uuid */
  templateUuid: string
}

export interface ProjectOpenResult {
  info: ProjectInfoDto
  root: NodeDto
  /**
   * 打开工程时读到的非致命问题，当前只有"块上的 lock 取值不认识，已按不锁处理"。
   * 类型认不出、属性读不出来属于数据损坏：那种情况直接拒绝载入，不会走到这里。
   * 界面要把这些警告弹给用户，否则用户不知道自己的数据被怎么解释了。
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
  uuid: string
  /** 展示名：中文名，空则退英文名，再空则退 uuid 前八位 */
  name: string
  category: string
  description: string
  version: string
  /** 结构里写的默认样式 uuid，空串表示还没选 */
  defaultStyleUuid: string
}

export interface StyleTemplateDto {
  uuid: string
  /** 展示名 */
  name: string
  version: string
  description: string
}

/** 导出可选的样式：新口径下每份样式都完整，所以没有"不可用"这一档 */
export interface StyleOptionDto {
  uuid: string
  /** 展示名 */
  name: string
  version: string
  /** 是不是这份文档的结构里写的默认样式 */
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

// ---------- 模板编辑（DESIGN-03）----------

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
  /** 模板 uuid，读写都按它定位 */
  uuid: string
  /** 展示名：中文名，空则退英文名，再空则退 uuid 前八位 */
  name: string
  /** 英文名，副名，可留空；列表上排在主名后面 */
  en: string
  errors: number
  warnings: number
  issues: TemplateIssueDto[]
  /**
   * 样式条目：哪些结构模板把这份样式写成了默认样式（展示名）。
   * 结构条目上没有这一项；界面靠它显示"这份样式被谁共用"。
   */
  usedBy?: string[]
}

/** 一个模板目录的现状 */
export interface TemplateDirSnapshotDto {
  dir: string
  exists: boolean
  /** 目录级问题：目录不存在、子目录缺失、目录名不是 uuid 等 */
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
  uuid: string
}

/** 读一份结构模板：doc 是解析后的原文，界面按字段编辑，没认得的字段原样保留 */
export interface TemplateReadResult {
  dir: string
  uuid: string
  doc: Record<string, unknown>
  issues: TemplateIssueDto[]
}

export interface TemplateSaveInput {
  dir: string
  uuid: string
  doc: Record<string, unknown>
}

export interface TemplateSaveResult {
  savedAt: string
  issues: TemplateIssueDto[]
}

export interface TemplateCreateInput {
  dir: string
  /** 结构模板的中文名，主名 */
  cn: string
  /** 英文名，副名，可留空 */
  en?: string
  /** 默认样式 uuid，可留空 */
  defaultStyleUuid?: string
}

/** 删除一份模板（结构模板与样式模板共用这对入参：都按 uuid 定位目录，都是整份目录的事） */
export interface TemplateDeleteInput {
  dir: string
  uuid: string
}

export interface TemplateRenameInput {
  dir: string
  /** 要改名的那一份 */
  uuid: string
  /** 中文名，主名 */
  cn: string
  /** 英文名，副名，可留空 */
  en?: string
}

// ---------- 试跑（DESIGN-03）----------

export interface TemplateTrialInput {
  dir: string
  /** 结构模板的 uuid（DESIGN-04：引用只认 uuid） */
  uuid: string
}

/**
 * 试跑结果：拿这份结构模板 + 它默认的样式模板，真的导出一份 .docx 出来。
 * **样式告警必须为零**才算通过（结构里用到的每个样式键都在骨架里找到了对应样式）。
 */
export interface TemplateTrialResult {
  /** 产物落哪了（应用数据目录下的 template-trials/，可以直接用 Word 打开） */
  outputPath: string
  /** 实例化出来多少节点 */
  nodes: number
  /** 用的哪份样式模板（uuid），没配就是空串 */
  styleUuid: string
  /** 导出链路的全部告警 */
  warnings: string[]
  /** 其中"样式未生效"那一类（判据看它） */
  styleWarnings: string[]
}

// ---------- 样式对照表（DESIGN-03）----------

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
  /** ok 正常 / dangling 指向的样式不在骨架里 / inert 配了不生效 / unset 没配 / unchecked 骨架没读到没核对 */
  status: 'ok' | 'dangling' | 'inert' | 'unset' | 'unchecked'
  /** 一句话结论（直接展示） */
  message: string
  /** 没配时程序回退用哪个逻辑键；null = 按 Word 默认样式输出 */
  fallback: string | null
}

export interface TemplateStyleReadInput {
  dir: string
  uuid: string
}

/**
 * 骨架的事实（目录在不在、缺哪些部件、有哪些 styleId、起始编号）。
 * 编辑模式拿它在本地跑**同一套**样式规则（`@documentor/templates/style-rules`），
 * 所以这里给的是事实，不是结论。
 */
export interface TemplateStyleSkeletonDto {
  /** 骨架文件夹名（stylemap 的 docxFolder） */
  folder: string
  exists: boolean
  /** 缺哪些必需部件（顺序固定） */
  missingParts: string[]
  styleIds: string[]
  headingStarts?: number[]
}

/** 把这份样式写成默认样式的结构模板：共用影响面 */
export interface TemplateStyleUserDto {
  uuid: string
  /** 展示名 */
  name: string
}

/**
 * 读一份样式模板：stylemap 原文（界面按字段改，没认得的字段原样保留）、
 * 骨架里的样式表（下拉的选项）、按**软件支持的全集**算出的对照表，
 * 以及这份样式被哪些结构模板写成默认样式。
 */
export interface TemplateStyleReadResult {
  dir: string
  uuid: string
  doc: Record<string, unknown>
  /** 骨架目录绝对路径（`docxFolder` 拼出来的；不看它存不存在） */
  skeletonPath: string
  skeletonExists: boolean
  /** 骨架的事实（本地跑规则用） */
  skeleton: TemplateStyleSkeletonDto
  /** 骨架里的样式表；读不到是空表 */
  skeletonStyles: SkeletonStyleDto[]
  /** 骨架里有、这份对照表没人用的 styleId（顺便看看有没有漏配） */
  unusedStyleIds: string[]
  /** 对照表：认得的逻辑键全在，外加文件里多出来的键 */
  rows: StyleMapRowDto[]
  /** 哪些结构模板把这份样式写成默认样式 */
  usedBy: TemplateStyleUserDto[]
  issues: TemplateIssueDto[]
}

export interface TemplateStyleSaveInput {
  dir: string
  uuid: string
  doc: Record<string, unknown>
}

export interface TemplateStyleSaveResult {
  savedAt: string
  issues: TemplateIssueDto[]
}

/**
 * 导入一份自备样式（DESIGN-03）：
 * 源是 `.docx` 文件或**已经解包**的骨架目录，两条路走同一套部件检查。
 */
export interface TemplateStyleImportInput {
  dir: string
  /** 样式模板的中文名，主名 */
  cn: string
  /** 英文名，副名，可留空 */
  en?: string
  /** `.docx` 文件绝对路径，或骨架目录绝对路径 */
  source: string
  /** 骨架文件夹名（相对模板目录），缺省 skeleton */
  styleFolder?: string
}

/** 导入结果：读回来的那份 + 草稿填了哪些、还差哪些 */
export interface TemplateStyleImportResult {
  style: TemplateStyleReadResult
  draft: {
    /** 按样式名认出来、已经填上的键 */
    filled: string[]
    /** 没认出来、留空待填的键 */
    empty: string[]
  }
}

/**
 * 改一份样式模板的名字：只动样式自己那一个 JSON，**不碰目录、不碰文件、不碰引用**。
 * 结构按 uuid 引用这份样式，所以改名不影响任何结构模板。
 */
export interface TemplateStyleRenameInput {
  dir: string
  uuid: string
  /** 中文名，主名 */
  cn: string
  /** 英文名，副名，可留空 */
  en?: string
}

/** 改样式模板的结果：与读一份样式同形状 */
export type TemplateStyleRenameResult = TemplateStyleReadResult

/**
 * 迁移旧格式模板目录（DESIGN-04）：目录名不是 uuid 的那些，分配 uuid、改目录与文件名、
 * 把结构里的样式引用换成样式 uuid，清单文件退场。旧格式不并存，迁完就没有旧目录了。
 */
export interface TemplateMigrateInput {
  dir: string
}

export interface TemplateMigrateResult {
  /** 迁过去的结构模板与样式模板各多少份 */
  structures: number
  styles: number
  /** 清单文件在不在（在就删掉） */
  manifestRemoved: boolean
  /** 没迁成的目录与原因：一条一句人话 */
  skipped: string[]
  /** 迁成了但默认样式没着落的（旧文件写的样式键在这个目录里找不到），要用户重选 */
  restyle: string[]
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
  /** 选一个 .docx（导入自备样式用） */
  DialogSelectDocx: 'dialog:select-docx',

  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  TemplatesListStructures: 'templates:list-structures',
  TemplatesListStyles: 'templates:list-styles',
  /** 导出可选的样式：全部样式都能用，标出结构里写的默认那一份 */
  TemplatesStyleOptions: 'templates:style-options',
  /** 模板加载总览：配了哪些目录、各自加载到几套、没加载到的原因 */
  TemplatesDiagnose: 'templates:diagnose',
  /** 模板编辑：打开时的全貌（目录、模板、问题徽标） */
  TemplateSnapshot: 'template:snapshot',
  /** 模板编辑：读一份结构模板原文 */
  TemplateRead: 'template:read',
  /** 模板编辑：读一份样式模板（stylemap 原文 + 骨架样式表 + 对照表） */
  TemplateReadStyle: 'template:read-style',
  /** 模板编辑：写回样式模板的对照表（原子写），写入前必须零 error */
  TemplateSaveStyle: 'template:save-style',
  /** 模板编辑：导入自备样式（.docx 解包或骨架目录 + 部件检查 + 映射草稿） */
  TemplateImportStyle: 'template:import-style',
  /** 模板编辑：改样式模板的名字（只写那一个 JSON） */
  TemplateRenameStyle: 'template:rename-style',
  /** 模板编辑：删除样式模板（整份目录含骨架） */
  TemplateDeleteStyle: 'template:delete-style',
  /** 模板编辑：试跑——用这份模板真导出一份 .docx，看样式告警是不是零 */
  TemplateTrialRun: 'template:trial-run',
  /** 模板编辑：迁移旧格式目录（改目录与文件名、引用换 uuid、清单退场） */
  TemplateMigrate: 'template:migrate',
  /** 模板编辑：写回结构模板（原子写），写入前必须零 error */
  TemplateSave: 'template:save',
  /** 模板编辑：新建结构模板（uuid 由程序生成） */
  TemplateCreate: 'template:create',
  /** 模板编辑：删除结构模板（整份目录） */
  TemplateDelete: 'template:delete',
  /** 模板编辑：改结构模板的名字（只写那一个 JSON） */
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
 * 模板编辑（DESIGN-03）：只动模板目录，不碰工程库、不进撤销栈。
 * 结构模板可读可写、可改名与删除；样式模板可读，对照表（styleMap 与 captionNumbering）可写，
 * 也可改名与删除（动的是样式自己那一个 JSON 或整份目录，不含骨架里的字节）。
 */
export interface DesktopTemplateEditorApi {
  snapshot(): Promise<TemplateEditorSnapshotDto>
  read(input: TemplateReadInput): Promise<TemplateReadResult>
  readStyle(input: TemplateStyleReadInput): Promise<TemplateStyleReadResult>
  saveStyle(input: TemplateStyleSaveInput): Promise<TemplateStyleSaveResult>
  importStyle(input: TemplateStyleImportInput): Promise<TemplateStyleImportResult>
  save(input: TemplateSaveInput): Promise<TemplateSaveResult>
  create(input: TemplateCreateInput): Promise<TemplateReadResult>
  /** 试跑：用这份模板导出一份 .docx，返回导出告警（样式告警必须为零） */
  trialRun(input: TemplateTrialInput): Promise<TemplateTrialResult>
  /** 迁移旧格式目录：改目录与文件名、引用换 uuid、清单退场 */
  migrate(input: TemplateMigrateInput): Promise<TemplateMigrateResult>
  remove(input: TemplateDeleteInput): Promise<void>
  rename(input: TemplateRenameInput): Promise<TemplateReadResult>
  /** 删除样式模板：整份目录含骨架 */
  removeStyle(input: TemplateDeleteInput): Promise<void>
  /** 改样式模板的名字：只写那一个 JSON */
  renameStyle(input: TemplateStyleRenameInput): Promise<TemplateStyleRenameResult>
}

export interface DesktopUiStateApi {
  save(key: string, value: string): Promise<void>
  load(key: string): Promise<string>
}

export interface DesktopDialogApi {
  selectDproj(): Promise<string | null>
  selectDirectory(): Promise<string | null>
  selectImage(): Promise<string | null>
  /** 选一个 .docx（导入自备样式用） */
  selectDocx(): Promise<string | null>
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
  /** 导出可选的样式：全部样式，标出这份结构写的那一份 */
  styles(structureUuid: string): Promise<StyleOptionDto[]>
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
  /** 样式模板 uuid */
  styleUuid: string
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
