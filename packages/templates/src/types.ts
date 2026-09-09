/**
 * 模板系统类型（对齐旧版 templatedef.h / styletemplatedef.h）。
 * 数据完全来自 JSON：结构模板（*-structure.json）+ 样式模板（*-stylemap.json）。
 * 任何 docx 规范文档格式 = 一对「结构模板 + 样式模板（含骨架目录）」注册进 manifest。
 */

/** 模板中预置的内容块定义（模板 JSON 的 contentBlocks 条目） */
export interface TemplateContentBlockDef {
  type: string
  caption?: string
  content?: string
  language?: string
  rows?: number
  cols?: number
  headers?: string[]
  data?: string[][]
  items?: string[]
}

/** 模板节点定义（递归） */
export interface TemplateNodeDef {
  nodeType: string
  defaultTitle: string
  headingLevel: number
  description: string
  copyable: boolean
  deletable: boolean
  allowContentBlocks: boolean
  isSubTitle: boolean
  subTitleStyle: string
  subTitleAutoNumber: boolean
  copyGroupId: string
  defaultChildren: TemplateNodeDef[]
  contentBlocks: TemplateContentBlockDef[]
}

/** 结构模板定义 */
export interface TemplateDef {
  name: string
  category: string
  description: string
  version: string
  /** 默认样式映射文件名（不含 .json），如 'demo-stylemap'；必须 ∈ styleTemplates */
  styleTemplate: string
  /** 可用样式模板集合（1:N）；缺省时兼容回退为 [styleTemplate] */
  styleTemplates: string[]
  rootDef: TemplateNodeDef
}

/** 结构 × 样式配对候选（软校验：不可用不影响结构模板加载/编辑） */
export interface StyleCandidate {
  /** stylemap 文件名（不含 .json） */
  fileKey: string
  name: string
  version: string
  description: string
  /** 校验是否通过（键齐全 + 骨架 styleId 均在） */
  available: boolean
  /** 缺失的逻辑样式键（含骨架 styleId 缺失项）明细 */
  missingKeys: string[]
  /** 是否为结构模板声明为默认样式 */
  isDefault: boolean
}

/** 样式模板定义（stylemap + docx 骨架） */
export interface StyleTemplateDef {
  name: string
  version: string
  description: string
  /** stylemap 文件名（不含 .json），注册别名 */
  fileKey: string
  /** 骨架文件夹名（stylemap 内 docxFolder，如 'demo-style'） */
  docxFolder: string
  /** 骨架文件夹的父目录绝对路径（styles/<id>） */
  basePath: string
  /** 逻辑样式名 → styles.xml styleId */
  styleMap: Record<string, string>
  /**
   * 题注编号方式（缺省 auto）：
   * - auto：由 Word 按样式编号，导出时剥离题注文本中的手写序号（避免双重编号）
   * - static：序号由文本自带（导出时原样保留，样式不再编号）
   * 场景：表题需与图表章节号一致、但表出现在标题 3 之前时，Word 多级列表会顶高标题计数，
   * 此时改用 static 由数据侧给出准确编号。
   */
  captionNumbering?: { table?: 'auto' | 'static'; figure?: 'auto' | 'static' }
  /** 骨架目录绝对路径（basePath + '/' + docxFolder） */
  skeletonPath: string
}

export interface StyleValidationReport {
  valid: boolean
  /** styleMap 中不在 styles.xml 的条目 */
  missing: Array<{ logicalName: string; styleId: string }>
}

export interface LoadDirResult {
  dirPath: string
  structuresLoaded: number
  stylesLoaded: number
  /** 跳过的原因（同名已注册 / 文件缺失 / 解析失败） */
  skipped: string[]
}
