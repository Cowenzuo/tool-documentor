/**
 * 模板系统类型（PLAN-12：身份是 uuid，名字只作展示）。
 * 结构模板与样式模板各一份 JSON，目录名与文件名都用 uuid；
 * 结构里只记一个默认样式 uuid，找不到就是悬挂。
 */
import type { BlockLockLevel } from '@documentor/core'
import type { TemplateIdentity } from './identity'

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
  /** 表格纵向自动合并开关（缺省 false），语义见 core TableBlockProps.mergeVertical */
  mergeVertical?: boolean
  items?: string[]
  /**
   * 模板锁：`keep` 类型限制编辑（内容可改，类型不能换、也不能删）/ `readonly` 只读
   * （内容与类型都由模板给定）/ `type` 已作废的旧档位。
   * 不写就是不锁；非法取值加载时按不锁处理。位置不在档位里，由节点级「排版」管；
   * 档位与两个总闸怎么取交见 PLAN-13 与 PLAN-16。
   */
  lock?: BlockLockLevel
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
  /** 排版：块集合、顺序、类型能不能动；关掉后只能改各块的内容（缺省 true） */
  allowLayoutEdit: boolean
  isSubTitle: boolean
  subTitleStyle: string
  subTitleAutoNumber: boolean
  defaultChildren: TemplateNodeDef[]
  contentBlocks: TemplateContentBlockDef[]
}

/** 结构模板定义：身份取模板 JSON 里的 uuid，样式只记一个默认 uuid */
export interface TemplateDef extends TemplateIdentity {
  category: string
  description: string
  version: string
  /** 默认样式的 uuid，空串表示还没选；指向哪份样式不影响这份结构能否加载 */
  defaultStyleUuid: string
  rootDef: TemplateNodeDef
}

/** 题注编号方式：auto=样式多级列表；static=文本自带；field=STYLEREF+SEQ 域 */
export type CaptionNumberingMode = 'auto' | 'static' | 'field'

/** 样式模板定义（stylemap + docx 骨架） */
export interface StyleTemplateDef extends TemplateIdentity {
  version: string
  description: string
  /** 骨架文件夹名，相对模板自己那个目录（stylemap 内 docxFolder） */
  docxFolder: string
  /** 模板目录 `styles/<uuid>` 的绝对路径 */
  basePath: string
  /** 逻辑样式名 → styles.xml styleId */
  styleMap: Record<string, string>
  /**
   * 题注编号方式（缺省 auto）：
   * - auto：由 Word 按样式编号（样式带 numPr 多级列表），导出时剥离题注文本中的手写序号
   * - static：序号由文本自带（导出时原样保留，样式不再编号）
   * - field：导出为题注域——`{ STYLEREF 章节样式 \n }-{ SEQ 标签 \s 层级 }`，章节号随标题走、
   *   序号按所在节重启，不占用标题多级列表（避免"表在标题 3 之前"把标题计数顶高）
   * 场景：表题需与图表章节号一致、但表出现在标题 3 之前时，Word 多级列表会顶高标题计数，
   * 此时用 static（数据侧给出准确编号）或 field（域方式自动编号）。
   */
  captionNumbering?: {
    table?: CaptionNumberingMode
    figure?: CaptionNumberingMode
    /**
     * field 模式下 STYLEREF 引用的标题样式名（按标题层级，如 { "2": "标题 2", "3": "标题 3" }）。
     * Word 的 STYLEREF 只认样式在界面上的本地化名称（中文 Word 为「标题 N」），故由模板显式给出；
     * 缺省按 `标题 N` 推断，仍解析不到时该部分退化为导出时算好的静态文本。
     */
    chapterStyleNames?: Record<string, string>
  }
  /**
   * 骨架 numbering.xml 中各标题层级（ilvl 0..N）的起始编号，用于 field 模式算题注章节号缓存值。
   * 缺省全 1。
   */
  headingStarts?: number[]
  /** 骨架目录绝对路径（basePath + '/' + docxFolder） */
  skeletonPath: string
}

/**
 * 结构的默认样式解析结果：解析规则在 `resolve.ts`，这里只是把"目录里有没有"
 * 换成"加载好的那一份"。悬挂与未设是两种事实，调用方的说法不一样。
 */
export interface DefaultStyleRef {
  /** 加载好的样式模板；悬挂或未设时为空 */
  style: StyleTemplateDef | null
  /** 结构里写的那个 uuid，空串表示没写 */
  uuid: string
  /** 写了 uuid 但找不到这份样式，界面要标出来并要求重选 */
  dangling: boolean
  /** 没写默认样式，导出时先让用户选一份 */
  unset: boolean
}

export interface StyleValidationReport {
  valid: boolean
  /** styleMap 中不在 styles.xml 的条目 */
  missing: Array<{ logicalName: string; styleId: string }>
  /**
   * 不影响"可用"判定、但要说出来的问题：如骨架缺 `word/_rels/document.xml.rels`，
   * styles / numbering 从主文档到达不了。导出侧会补出这两条关系，故只警告不判不可用。
   */
  warnings: string[]
}

export interface LoadDirResult {
  dirPath: string
  structuresLoaded: number
  stylesLoaded: number
  /**
   * 没加载进来的东西与原因：整份模板被跳过（读不到、解析失败、缺 uuid、缺 root），
   * 或模板里的某个内容块被跳过（类型不认识）。一条一句人话，界面直接显示。
   */
  skipped: string[]
  /**
   * 加载成功但有可疑之处的条目：内容块 lock 取值不认识（按不锁处理）、
   * 样式骨架缺 `word/_rels/document.xml.rels` 之类。不阻断加载，
   * 但要出现在报告里，界面才能解释"为什么少了什么 / 为什么没生效"。
   */
  warnings: string[]
}
