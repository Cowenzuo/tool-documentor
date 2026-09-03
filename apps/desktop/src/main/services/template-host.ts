/**
 * 模板管理器装配：**仅加载用户配置的模板目录**（settings.template_dirs）。
 * 内置模板已剥离分发（版权考虑）：软件只提供处理管线，模板由外部提供。
 * 无任何模板时给出明确指引（不报错，便于欢迎页/向导展示空态）。
 */
import { TemplateManager } from '@documentor/templates'
import { loadAppSettings } from './config'

export function buildTemplateManager(): TemplateManager {
  const manager = new TemplateManager()
  const settings = loadAppSettings()
  const dirs = [...settings.template_dirs.filter((d) => d.trim().length > 0)]

  // 开发自检（DOC_E2E）：注入测试模板目录，不影响正常用户流程
  const e2eTemplates = process.env['DOC_E2E_TEMPLATES']
  if (e2eTemplates) dirs.unshift(e2eTemplates)

  let loadedAny = false
  for (const dir of dirs) {
    const result = manager.loadTemplateDir(dir)
    loadedAny = loadedAny || result.structuresLoaded > 0 || result.stylesLoaded > 0
    if (result.skipped.length > 0) {
      console.warn('[templates]', dir, result.skipped.join('; '))
    }
  }
  if (!loadedAny) {
    console.warn(
      '[templates] 未加载任何模板：请在 设置 → 模板目录 添加包含 manifest.json 的目录'
    )
  } else {
    console.log(
      `[templates] loaded ${manager.listStructures().length} structures, ${manager.listStyles().length} styles`
    )
  }
  return manager
}
