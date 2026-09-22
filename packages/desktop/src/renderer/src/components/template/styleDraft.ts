/**
 * 样式对照表的草稿层（渲染层）：所有编辑都落在内存里的 stylemap 原文上，
 * 写文件只发生在「保存」那一次（与结构模板那一侧同一套口径）。
 *
 * 判定与文案**直接用主进程那份实现**：`@documentor/templates/style-rules`（不碰 fs）
 * 与 `style-keys`（对照表行）。这里只负责"从读回来的事实 + 草稿算出结果"，
 * 不再维护第二份规则——校验一份实现（PLAN-11 第 8 节第 7 条）。
 */
import { buildStyleMapRows } from '@documentor/templates/style-keys'
import { validateStyleMap } from '@documentor/templates/style-rules'
import type { SkeletonFacts, StyleStructureFacts } from '@documentor/templates/style-rules'
import type {
  StyleMapRowDto,
  TemplateIssueDto,
  TemplateStyleReadResult
} from '../../../../shared/project'
import { asObject, type TemplateObject } from './templateDoc'

/** 题注编号的两种题注（与 stylemap 的 captionNumbering 同键） */
export type CaptionKind = 'table' | 'figure'
/** 三种编号方式（缺省 auto） */
export const CAPTION_MODES: ReadonlyArray<{ value: string; label: string; why: string }> = [
  { value: 'auto', label: '按样式自动编号', why: '号取自题注样式的多级列表 · 样式须自带编号' },
  { value: 'static', label: '题注文字自带', why: '号写在题注文字里 · 原样导出' },
  { value: 'field', label: '题注域', why: 'STYLEREF + SEQ 域 · 章节号随标题' }
]

/** 读回来的事实 → 骨架事实（规则要的形状） */
export function skeletonFactsOf(result: TemplateStyleReadResult): SkeletonFacts {
  return {
    folder: result.skeleton.folder,
    exists: result.skeleton.exists,
    missingParts: [...result.skeleton.missingParts],
    styleIds: [...result.skeleton.styleIds],
    styles: result.skeletonStyles.map((style) => ({
      styleId: style.styleId,
      name: style.name,
      type: style.type,
      isDefault: style.isDefault,
      ...(style.basedOn === undefined ? {} : { basedOn: style.basedOn }),
      ...(style.fontSizePt === undefined ? {} : { fontSizePt: style.fontSizePt }),
      ...(style.numbered === undefined ? {} : { numbered: style.numbered })
    })),
    ...(result.skeleton.headingStarts === undefined
      ? {}
      : { headingStarts: [...result.skeleton.headingStarts] })
  }
}

/**
 * 引用这份对照表的结构 → 规则要的"诉求"。`usedBy` 里的每一条本来就是因为引用了它才进来的，
 * 所以这里把文件键填成它，规则里那道"只比对声明引用了的结构"就自动对上。
 */
export function structureFactsOf(result: TemplateStyleReadResult): StyleStructureFacts[] {
  return result.usedBy.map((user) => ({
    name: user.name,
    fileKeys: [result.fileKey],
    keys: [...user.requiredKeys],
    captions: user.captions.map((caption) => ({ ...caption }))
  }))
}

/** 草稿的 styleMap（不是对象就当空：校验会自己报"缺 styleMap"） */
export function styleMapOf(doc: TemplateObject | null): Record<string, unknown> {
  return (doc ? asObject(doc['styleMap']) : null) ?? {}
}

/** 草稿的 captionNumbering（不是对象就当没有） */
export function captionNumberingOf(doc: TemplateObject | null): TemplateObject | null {
  return doc ? asObject(doc['captionNumbering']) : null
}

/** 对照表行：用**草稿**算（读回来的那份 rows 只在服务层与测试里用） */
export function styleRowsFor(
  result: TemplateStyleReadResult | null,
  doc: TemplateObject | null
): StyleMapRowDto[] {
  if (!result || !doc) return []
  return buildStyleMapRows({
    styleMap: styleMapOf(doc),
    requirements: result.usedBy.map((user) => ({ name: user.name, keys: user.requiredKeys })),
    skeletonStyleIds: result.skeleton.styleIds.length > 0 ? result.skeleton.styleIds : null,
    skeletonStyles: skeletonFactsOf(result).styles
  })
}

/** 校验结论：同一套规则跑在草稿上（有 error 就不许保存） */
export function styleIssuesFor(
  result: TemplateStyleReadResult | null,
  doc: TemplateObject | null
): TemplateIssueDto[] {
  if (!result || !doc) return []
  return validateStyleMap(doc, structureFactsOf(result), {
    id: result.id,
    stylemapFile: result.file,
    manifestStyleFolder: result.manifestStyleFolder,
    skeleton: skeletonFactsOf(result)
  })
}

/**
 * 改一行映射：`styleId` 为 null 表示「不配」——**把这一项从 styleMap 里删掉**
 * （不是写空串：删掉才叫没配，校验与导出都按"没有这一项"算）。
 */
export function withStyleMapEntry(
  doc: TemplateObject,
  key: string,
  styleId: string | null
): TemplateObject {
  const styleMap = { ...styleMapOf(doc) }
  if (styleId === null || styleId === '') delete styleMap[key]
  else styleMap[key] = styleId
  return { ...doc, styleMap }
}

/** 改一种题注的编号方式；`mode` 为 null 表示删掉这一项（等于按 auto 处理） */
export function withCaptionMode(
  doc: TemplateObject,
  kind: CaptionKind,
  mode: string | null
): TemplateObject {
  const cn = { ...(captionNumberingOf(doc) ?? {}) }
  if (mode === null) delete cn[kind]
  else cn[kind] = mode
  return { ...doc, captionNumbering: cn }
}

/** 改 field 模式用的章节样式名（按标题层级）；`name` 为 null 表示删掉这一层 */
export function withChapterStyleName(
  doc: TemplateObject,
  level: string,
  name: string | null
): TemplateObject {
  const cn = { ...(captionNumberingOf(doc) ?? {}) }
  const names = { ...(asObject(cn['chapterStyleNames']) ?? {}) }
  if (name === null) delete names[level]
  else names[level] = name
  cn['chapterStyleNames'] = names
  return { ...doc, captionNumbering: cn }
}
