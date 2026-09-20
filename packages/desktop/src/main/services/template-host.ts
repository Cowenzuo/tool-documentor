/**
 * 模板管理器装配：**仅加载用户配置的模板目录**（settings.template_dirs）。
 * 内置模板已剥离分发（版权考虑）：软件只提供处理管线，模板由外部提供。
 * 无任何模板时给出明确指引（不报错，便于欢迎页/向导展示空态）。
 *
 * 加载结果同时产出一份 **TemplateLoadReport**，供设置界面与新建向导显示
 * 「配了哪几个目录、各自加载到几套模板、没加载到是为什么」。
 * 配错一层目录（比如指到模板仓库根而不是含 manifest.json 的那层）时，
 * 界面必须能说清原因，不能让用户对着空白猜。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { TemplateManager } from '@documentor/templates'
import type { TemplateDirReport, TemplateLoadReport } from '../../shared/project'
import { loadAppSettings } from './config'

/** 把加载器的技术性跳过原因翻译成用户能照着动作的话 */
function toUserReason(raw: string): string {
  if (raw.startsWith('manifest.json not found')) {
    return '该目录没有 manifest.json；模板目录要选到含 manifest.json 的那一层（模板仓库里是 packages/ 子目录）'
  }
  if (raw.startsWith('manifest.json parse error')) {
    return 'manifest.json 不是合法 JSON，整个目录会被跳过'
  }
  if (raw.startsWith('invalid structure entry')) {
    return 'manifest 的 structures 里有条目缺 id 或 file，该条被跳过'
  }
  if (raw.startsWith('invalid style entry')) {
    return 'manifest 的 styles 里有条目缺 id 或 stylemap_file，该条被跳过'
  }
  if (raw.startsWith('cannot load structure')) {
    return '结构模板文件读不到或解析失败；确认目录名等于 manifest 的 id、文件名等于 file'
  }
  if (raw.startsWith('cannot load stylemap')) {
    return '样式映射文件读不到或解析失败；确认目录名等于 manifest 的 id'
  }
  if (raw.startsWith('structure already loaded')) {
    return `结构模板与已加载目录里的同名，保留先加载的那份：${raw.slice('structure already loaded: '.length)}`
  }
  if (raw.startsWith('style already loaded')) {
    return `样式模板与已加载目录里的同名，保留先加载的那份：${raw.slice('style already loaded: '.length)}`
  }
  return raw
}

export interface TemplateHost {
  manager: TemplateManager
  report: TemplateLoadReport
}

export function buildTemplateManager(): TemplateHost {
  const manager = new TemplateManager()
  const settings = loadAppSettings()
  const dirs = [...settings.template_dirs.filter((d) => d.trim().length > 0)]

  // 本机冒烟用：只有显式开了 DOC_E2E 才认这个目录覆盖，正常启动不受环境变量影响
  const e2eTemplates = process.env['DOC_E2E'] ? process.env['DOC_E2E_TEMPLATES'] : undefined
  if (e2eTemplates) dirs.unshift(e2eTemplates)

  const dirReports: TemplateDirReport[] = []
  for (const dir of dirs) {
    const exists = existsSync(dir)
    const hasManifest = exists && existsSync(join(dir, 'manifest.json'))
    const result = manager.loadTemplateDir(dir)
    const loaded = result.structuresLoaded + result.stylesLoaded
    const report: TemplateDirReport = {
      dir,
      exists,
      hasManifest,
      structures: result.structuresLoaded,
      styles: result.stylesLoaded,
      loadFailed: loaded === 0,
      reasons: result.skipped.map(toUserReason),
      // 警告条目本身就是给人看的中文短句，不再经翻译
      warnings: result.warnings
    }
    dirReports.push(report)
    if (result.skipped.length > 0 || result.warnings.length > 0) {
      console.warn(
        '[templates]',
        dir,
        [...result.skipped, ...result.warnings].join('; ')
      )
    }
  }

  const structures = manager.listStructures().length
  const styles = manager.listStyles().length
  const loadedAny = structures > 0 || styles > 0

  if (!loadedAny) {
    console.warn(
      '[templates] 未加载任何模板：请在 设置 → 模板目录 添加包含 manifest.json 的目录'
    )
  } else {
    console.log(`[templates] loaded ${structures} structures, ${styles} styles`)
  }

  return {
    manager,
    report: { dirs: dirReports, structures, styles, loadedAny }
  }
}
