/**
 * 模板引用解析（PLAN-12）：引用只有 uuid，找不到就是悬挂。
 *
 * 为什么单独一层：旧口径是"按名字与文件名配对 + 清单登记 + 覆盖度兜底"，
 * 新口径只有一句话：拿 uuid 去找，找到就用，找不到就报悬挂，交给用户重选。
 * 解析规则只写在这里，加载器与导出对话框都调它，不各自判一遍。
 *
 * 唯一一处按名字走的是老工程：PLAN-12 之前锚点与库表里记的是模板名
 * （`438C-软件设计说明(SDD)` 这种写法）。那是一个只读一次的口子，认到 uuid 之后就
 * 回到"只认 uuid"，名字不留在任何新写入里。
 */
import type { DiscoveredTemplate, TemplateScan } from './discover'
import { legacyNameOf, normalizeTemplateName } from './identity'
import type { TemplateIdentity } from './identity'

export interface StyleResolution {
  /** 解析出来的样式模板；悬挂时为空 */
  style: DiscoveredTemplate | null
  /** 结构里写的那个 uuid，空串表示结构没写默认样式 */
  uuid: string
  /** 悬挂：写了 uuid 但目录里没有这份，界面要标出来并要求重选 */
  dangling: boolean
  /** 没写默认样式：导出时让用户先选一份 */
  unset: boolean
}

function findReadable(
  list: readonly DiscoveredTemplate[],
  uuid: string
): DiscoveredTemplate | null {
  const hit = list.find((item) => item.uuid === uuid)
  // 读坏的那份不算能用的样式：宁可报悬挂，也不要拿半份去导出
  return hit && hit.problem === null ? hit : null
}

/** 按 uuid 找结构模板 */
export function findStructureByUuid(scan: TemplateScan, uuid: string): DiscoveredTemplate | null {
  return findReadable(scan.structures, uuid)
}

/** 按 uuid 找样式模板 */
export function findStyleByUuid(scan: TemplateScan, uuid: string): DiscoveredTemplate | null {
  return findReadable(scan.styles, uuid)
}

/** 一份模板能被老引用指到的所有写法：中文名、英文名、老版本的「中文名(英文名)」 */
function legacyCandidateNames(identity: TemplateIdentity): string[] {
  const names = [identity.cn, identity.en, legacyNameOf(identity)]
  return names.map((n) => n.trim()).filter((n) => n !== '')
}

/**
 * 老工程只记了模板名，按名字认回结构模板。
 * 认到**唯一**一份能读的结构模板才算数：认不出、或者撞名字（两份模板同名）一律返回 null，
 * 由上层按悬挂处理让用户重选，不猜是哪一份。
 */
export function findStructureByLegacyName(
  scan: TemplateScan,
  legacyName: string
): DiscoveredTemplate | null {
  const want = normalizeTemplateName(legacyName)
  if (want === '') return null
  const hits = scan.structures.filter(
    (item) =>
      item.problem === null &&
      item.identity !== null &&
      legacyCandidateNames(item.identity).some((name) => normalizeTemplateName(name) === want)
  )
  return hits.length === 1 ? (hits[0] ?? null) : null
}

/** 结构的默认样式：找到就用，找不到分"没写"与"悬挂"两种情况报出去 */
export function resolveDefaultStyle(
  scan: TemplateScan,
  defaultStyleUuid: string | undefined
): StyleResolution {
  const uuid = typeof defaultStyleUuid === 'string' ? defaultStyleUuid.trim() : ''
  if (uuid === '') return { style: null, uuid: '', dangling: false, unset: true }
  const style = findStyleByUuid(scan, uuid)
  return { style, uuid, dangling: style === null, unset: false }
}

/**
 * 导出时能选的样式：全部能读的样式。
 * 新口径下样式模板一律完整，所以没有任何"这份结构不能用"的样式。
 */
export function stylesForExport(scan: TemplateScan): DiscoveredTemplate[] {
  return scan.styles.filter((item) => item.problem === null)
}
