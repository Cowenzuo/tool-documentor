/**
 * 工程锚点文件 documentor.dproj（JSON）读写。
 * 工程目录 = 锚点文件所在目录：<dir>/documentor.dproj + db_file + images/ + mermaid/
 *
 * 老工程（改用 uuid 之前）这里记的是模板名（`template` 键）。名字只用来认一次 uuid，
 * 认到就换成 `template_uuid` 记；认不到就原样留着，不把线索抹掉。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const ANCHOR_FILE_NAME = 'documentor.dproj'
export const DEFAULT_DB_FILE = 'documentor.db'

export interface ProjectAnchor {
  version: number
  name: string
  /** 结构模板的 uuid（DESIGN-04：引用只认 uuid，名字不参与匹配） */
  template_uuid: string
  /**
   * 老工程写的模板名（锚点里的 `template`、库里的 `template_name`）。
   * 只在"库里没有 uuid"时读一次：按名字认回 uuid 之后不再写这一项。
   */
  legacyTemplateName?: string
  db_file: string
  created_at: string
  updated_at: string
}

export function anchorPath(projectDir: string): string {
  return join(projectDir, ANCHOR_FILE_NAME)
}

/** 读锚点；不存在/解析失败返回 null */
export function readAnchor(projectDir: string): ProjectAnchor | null {
  const file = anchorPath(projectDir)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const legacyName = raw['template']
    return {
      version: Number(raw['version'] ?? 1),
      name: String(raw['name'] ?? ''),
      template_uuid: String(raw['template_uuid'] ?? ''),
      legacyTemplateName: typeof legacyName === 'string' ? legacyName : '',
      db_file: String(raw['db_file'] ?? DEFAULT_DB_FILE),
      created_at: String(raw['created_at'] ?? ''),
      updated_at: String(raw['updated_at'] ?? '')
    }
  } catch {
    return null
  }
}

/**
 * 写锚点。已认到 uuid 的工程只写 `template_uuid`；
 * 还没认到的老工程把名字写回 `template`，免得一次保存就把名字丢了。
 */
export function writeAnchor(projectDir: string, anchor: ProjectAnchor): void {
  const resolved = anchor.template_uuid !== ''
  const legacyName = anchor.legacyTemplateName ?? ''
  const ref = resolved
    ? { template_uuid: anchor.template_uuid }
    : legacyName !== ''
      ? { template: legacyName }
      : { template_uuid: '' }
  const payload = {
    version: anchor.version,
    name: anchor.name,
    ...ref,
    db_file: anchor.db_file,
    created_at: anchor.created_at,
    updated_at: anchor.updated_at
  }
  writeFileSync(anchorPath(projectDir), JSON.stringify(payload, null, 2), 'utf8')
}

/** 由锚点得到 db 绝对路径 */
export function dbPathOf(projectDir: string, anchor: ProjectAnchor): string {
  return join(projectDir, anchor.db_file)
}

/** 由 dproj 文件路径得到工程目录（dirname） */
export function projectDirOf(dprojPath: string): string {
  return dirname(dprojPath)
}
