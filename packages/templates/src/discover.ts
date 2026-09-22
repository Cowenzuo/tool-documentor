/**
 * 模板目录扫描（PLAN-12）：目录名就是 uuid，文件名是 `<uuid>.json`，清单不再存在。
 *
 * 为什么不直接改 manager：换加载器要同时动"怎么找文件"和"怎么解释文件内容"两件事，
 * 分开做才能一步一步验。这里只负责找与读，判定与解释仍归 validate。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isTemplateUuid, templateFileName, templateIdentityOf, displayNameOf } from './identity'
import type { TemplateIdentity } from './identity'

export type TemplateKind = 'structure' | 'style'

/** 两类模板在模板目录下的固定子目录名，硬约定 */
export const TEMPLATE_SUBDIR: Record<TemplateKind, string> = {
  structure: 'structures',
  style: 'styles'
}

export interface DiscoveredTemplate {
  kind: TemplateKind
  /** 读得出身份才有值；读不出时按下面的 problem 处理 */
  identity: TemplateIdentity | null
  /** 目录名推导出来的 uuid，与文件里写的 uuid 应当一致 */
  uuid: string
  /** 展示名，读不出身份时退 uuid 前八位 */
  name: string
  dir: string
  file: string
  /** 读不了或读坏了的原因，正常时为空 */
  problem: string | null
  /** 解析出来的 JSON 原文，读不了时为空 */
  doc: Record<string, unknown> | null
}

/** 目录名不是 uuid 的旧格式目录：交给迁移动作提示，扫描本身不猜内容 */
export interface LegacyTemplateDir {
  kind: TemplateKind
  name: string
  dir: string
}

export interface TemplateScan {
  structures: DiscoveredTemplate[]
  styles: DiscoveredTemplate[]
  legacy: LegacyTemplateDir[]
  /** 顶层子目录都缺的类别，例如整个 styles 目录不存在 */
  missing: TemplateKind[]
}

function readJsonObject(file: string): { doc: Record<string, unknown> | null; problem: string | null } {
  let raw = ''
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { doc: null, problem: '模板文件读不到' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { doc: null, problem: '模板文件解析失败' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { doc: null, problem: '模板文件解析失败' }
  }
  return { doc: parsed as Record<string, unknown>, problem: null }
}

function scanKind(root: string, kind: TemplateKind, scan: TemplateScan): void {
  const base = join(root, TEMPLATE_SUBDIR[kind])
  let entries: string[] = []
  try {
    if (!statSync(base).isDirectory()) {
      scan.missing.push(kind)
      return
    }
    entries = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    scan.missing.push(kind)
    return
  }

  const out = kind === 'structure' ? scan.structures : scan.styles
  for (const name of entries) {
    const dir = join(base, name)
    if (!isTemplateUuid(name)) {
      scan.legacy.push({ kind, name, dir })
      continue
    }
    const file = join(dir, templateFileName(name))
    const { doc, problem } = readJsonObject(file)
    const identity = templateIdentityOf(doc)
    // 目录名与文件里的 uuid 不一致：这份不能当同一份用，报出来让人处理
    const mismatch = identity !== null && identity.uuid !== name
    out.push({
      kind,
      identity: mismatch ? null : identity,
      uuid: name,
      name: identity !== null && !mismatch ? displayNameOf(identity) : name.slice(0, 8),
      dir,
      file,
      problem: problem ?? (identity === null ? '模板缺少 uuid' : mismatch ? '目录名与 uuid 不一致' : null),
      doc: mismatch ? null : doc
    })
  }
}

/**
 * 扫一遍模板目录。不读清单、不按名字配对：目录名是 uuid 才认，
 * 其余目录收进 legacy，交给迁移动作去问用户。
 */
export function scanTemplateDir(root: string): TemplateScan {
  const scan: TemplateScan = { structures: [], styles: [], legacy: [], missing: [] }
  scanKind(root, 'structure', scan)
  scanKind(root, 'style', scan)
  return scan
}
