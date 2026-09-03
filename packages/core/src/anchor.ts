/**
 * 工程锚点文件 documentor.dproj（JSON）读写。
 * 工程目录 = 锚点文件所在目录：<dir>/documentor.dproj + db_file + images/ + mermaid/
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const ANCHOR_FILE_NAME = 'documentor.dproj'
export const DEFAULT_DB_FILE = 'documentor.db'

export interface ProjectAnchor {
  version: number
  name: string
  template: string
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
    return {
      version: Number(raw['version'] ?? 1),
      name: String(raw['name'] ?? ''),
      template: String(raw['template'] ?? ''),
      db_file: String(raw['db_file'] ?? DEFAULT_DB_FILE),
      created_at: String(raw['created_at'] ?? ''),
      updated_at: String(raw['updated_at'] ?? '')
    }
  } catch {
    return null
  }
}

export function writeAnchor(projectDir: string, anchor: ProjectAnchor): void {
  const payload = {
    version: anchor.version,
    name: anchor.name,
    template: anchor.template,
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
