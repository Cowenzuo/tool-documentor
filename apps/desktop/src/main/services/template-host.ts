/**
 * 模板管理器装配与热重载：用户配置目录（先加载优先）→ 内置兜底。
 * ProjectService 持有 manager 引用，settings 保存后经 reloadTemplates 即时替换。
 */
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TemplateManager } from '@documentor/templates'
import { loadAppSettings } from './config'

export function resolveBuiltinTemplatesDir(): string {
  const candidates: string[] = []
  if (app.isPackaged) {
    candidates.push(join(process.resourcesPath, 'templates'))
  } else {
    candidates.push(join(app.getAppPath(), '..', '..', 'resources', 'templates'))
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, 'manifest.json'))) return dir
  }
  return candidates[0] ?? ''
}

export function buildTemplateManager(): TemplateManager {
  const manager = new TemplateManager()
  const settings = loadAppSettings()
  const dirs = [...settings.template_dirs.filter((d) => d.trim().length > 0)]
  const builtin = resolveBuiltinTemplatesDir()
  for (const dir of dirs) {
    const result = manager.loadTemplateDir(dir)
    if (result.skipped.length > 0) {
      console.warn('[templates]', dir, result.skipped.join('; '))
    }
  }
  const builtinResult = manager.loadTemplateDir(builtin)
  if (manager.listStructures().length === 0 && builtinResult.skipped.length > 0) {
    console.error('[templates] no templates available:', builtinResult.skipped.join('; '))
  }
  console.log(
    `[templates] loaded ${manager.listStructures().length} structures, ${manager.listStyles().length} styles`
  )
  return manager
}
