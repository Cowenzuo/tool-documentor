/**
 * 应用配置（对齐旧版 config.json 字段语义；位置 = Electron userData）。
 * { version, default_project_dir, template_dirs }
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface AppSettings {
  version: number
  default_project_dir: string
  template_dirs: string[]
  /** 最近打开的 dproj 绝对路径（最新在前） */
  recents?: string[]
}

const SETTINGS_FILE = 'config.json'
const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  default_project_dir: '',
  template_dirs: []
}

export function configFilePath(): string {
  return join(app.getPath('userData'), SETTINGS_FILE)
}

export function loadAppSettings(): AppSettings {
  try {
    const file = configFilePath()
    if (!existsSync(file)) return { ...DEFAULT_SETTINGS }
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AppSettings>
    return {
      version: Number(raw.version ?? 1),
      default_project_dir: String(raw.default_project_dir ?? ''),
      template_dirs: Array.isArray(raw.template_dirs)
        ? raw.template_dirs.filter((d): d is string => typeof d === 'string')
        : [],
      recents: Array.isArray(raw.recents) ? raw.recents.filter((d): d is string => typeof d === 'string') : []
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveAppSettings(settings: AppSettings): void {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    configFilePath(),
    JSON.stringify(
      {
        version: settings.version,
        default_project_dir: settings.default_project_dir,
        template_dirs: settings.template_dirs,
        recents: settings.recents ?? []
      },
      null,
      2
    ),
    'utf8'
  )
}

/** 把 dproj 记入最近列表并落盘 */
export function addRecentProject(dprojPath: string, limit = 8): void {
  const settings = loadAppSettings()
  const next = [dprojPath, ...(settings.recents ?? []).filter((p) => p !== dprojPath)].slice(0, limit)
  saveAppSettings({ ...settings, recents: next })
}

export function loadRecents(): string[] {
  const settings = loadAppSettings()
  return (settings.recents ?? []).filter((p) => existsSync(p))
}
