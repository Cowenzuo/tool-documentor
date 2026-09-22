/**
 * 模板身份（PLAN-12）：uuid 是唯一身份，中文名与英文名只作展示。
 *
 * 为什么单开一个模块：身份与命名分开之后，"这是不是同一份模板"只由 uuid 决定，
 * 名字可以随便改。读写两个方向、目录名与文件名的推导都收在这里，别处不许自己拼字符串，
 * 否则又会长出第二套"按名字认模板"的口径。
 */
export interface TemplateIdentity {
  /** 程序生成，永不变，界面不显示 */
  uuid: string
  /** 中文名，主名 */
  cn: string
  /** 英文名，副名，可留空 */
  en: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * 用 Web Crypto 的 randomUUID 而不是 node:crypto：渲染层要跑同一套 uuid 判定，
 * 这里一旦 import node 内置模块，编辑模式的浏览器包就会带上一个用不了的 shim。
 */
export function newTemplateUuid(): string {
  return globalThis.crypto.randomUUID()
}

export function isTemplateUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** 目录名就是 uuid，文件名是 <uuid>.json：改名不动文件，所以两者都不带名字 */
export function templateFileName(uuid: string): string {
  return `${uuid}.json`
}

/**
 * 从模板 JSON 原文读身份。uuid 必须是合法 uuid，缺了或写坏了返回 null，
 * 调用方按"这份模板读不了"处理，不猜、不按名字兜底。
 */
export function templateIdentityOf(doc: Record<string, unknown> | null | undefined): TemplateIdentity | null {
  if (!doc) return null
  const uuid = doc['uuid']
  if (!isTemplateUuid(uuid)) return null
  const cn = doc['cn']
  const en = doc['en']
  return {
    uuid,
    cn: typeof cn === 'string' ? cn : '',
    en: typeof en === 'string' ? en : ''
  }
}

/** 展示名：主名取中文名，空则退英文名，再空则退 uuid 前八位，保证列表里不出现空条目 */
export function displayNameOf(identity: TemplateIdentity): string {
  if (identity.cn.trim() !== '') return identity.cn
  if (identity.en.trim() !== '') return identity.en
  return identity.uuid.slice(0, 8)
}

/** 把身份写回 JSON 时用的三个字段：新建与改名共用，字段顺序固定 */
export function identityFields(identity: TemplateIdentity): Record<string, string> {
  const fields: Record<string, string> = { uuid: identity.uuid, cn: identity.cn }
  if (identity.en !== '') fields['en'] = identity.en
  return fields
}
