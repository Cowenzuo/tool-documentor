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
  /** 样式映射文件名（不含 .json），如 '438c-srs-stylemap' */
  styleTemplate: string
  rootDef: TemplateNodeDef
}

/** 样式模板定义（stylemap + docx 骨架） */
export interface StyleTemplateDef {
  name: string
  version: string
  description: string
  /** stylemap 文件名（不含 .json），注册别名 */
  fileKey: string
  /** 骨架文件夹名（stylemap 内 docxFolder，如 '438c-srs-style'） */
  docxFolder: string
  /** 骨架文件夹的父目录绝对路径（styles/<id>） */
  basePath: string
  /** 逻辑样式名 → styles.xml styleId */
  styleMap: Record<string, string>
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
