/**
 * Documentor CLI：--test-export <instance.json> [out.docx]
 * 对齐旧版 main.cpp --test-export 语义：
 *  - 模板匹配：basedOn（结构模板名）→ styleTemplate（结构模板 styleTemplate 字段）→ 首模板（警告）
 *  - 无 instance 参数时用首个模板实例化空树（兼容旧行为）
 *  - 输出缺省：当前工作目录 test_output.docx
 *  - **模板目录必须外部提供**（软件不内置模板）：
 *      环境变量 DOC_TEMPLATES_DIR <dir> 或参数 --templates <dir>
 * 用法：node cli/test-export.cjs <instance.json> [输出.docx] [--templates <dir>]
 */
const { existsSync, readFileSync, statSync } = require('node:fs')
const path = require('node:path')
const { TemplateManager } = require('@documentor/templates')
const core = require('@documentor/core')
const docx = require('@documentor/docx')

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

function parseArgs(args) {
  let instancePath = ''
  let outputPath = ''
  let templatesDir = process.env.DOC_TEMPLATES_DIR || ''
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--templates' && args[i + 1]) {
      templatesDir = args[i + 1]
      i++
    } else if (args[i].toLowerCase().endsWith('.json')) {
      instancePath = args[i]
    } else if (!outputPath) {
      outputPath = args[i]
    }
  }
  return { instancePath, outputPath, templatesDir }
}

async function main() {
  const { instancePath, outputPath: _out, templatesDir } = parseArgs(process.argv.slice(2))
  const outputPath = _out && _out.length > 0 ? _out : path.join(process.cwd(), 'test_output.docx')

  console.log('=== DOCX Export Test ===')

  if (!templatesDir) {
    return fail('未指定模板目录：请通过环境变量 DOC_TEMPLATES_DIR 或参数 --templates <dir> 提供（软件不内置模板）')
  }
  if (!existsSync(templatesDir) || !statSync(templatesDir).isDirectory()) {
    return fail(`模板目录不存在：${templatesDir}`)
  }

  const manager = new TemplateManager()
  manager.loadTemplateDir(templatesDir)
  const structures = manager.listStructures()
  if (structures.length === 0) {
    return fail(`模板目录无效（缺少 manifest.json 或未加载到结构模板）：${templatesDir}`)
  }

  let def = null
  let tree = null
  /** 实例 JSON（仅 --test-export 带参数时存在） */
  let instance = null

  if (instancePath) {
    if (!existsSync(instancePath)) return fail(`cannot open ${instancePath}`)
    console.log('Loading instance:', instancePath)
    try {
      instance = JSON.parse(readFileSync(instancePath, 'utf8'))
    } catch (err) {
      return fail(`JSON parse error: ${err.message}`)
    }
    const basedOn = instance.basedOn || ''
    const styleTemplate = instance.styleTemplate || ''
    console.log('Instance basedOn:', basedOn, 'style:', styleTemplate)
    if (basedOn) def = manager.findStructureByName(basedOn)
    if (!def && styleTemplate) {
      for (const t of structures) {
        if (t.styleTemplate === styleTemplate) {
          def = t
          break
        }
      }
    }
    if (!def) {
      console.warn(`WARN: template "${basedOn || styleTemplate}" not found, using first template`)
      def = structures[0]
    }
    console.log('Template:', def.name)
    tree = core.buildTreeFromInstance(instance)
    console.log('Tree built from instance, root:', tree.root.title)
  } else {
    def = structures[0]
    console.log('Template:', def.name)
    tree = manager.instantiate(def)
    if (!tree) return fail('cannot instantiate template')
    console.log('Tree instantiated, root:', tree.root.title)
  }

  // 样式：按结构模板声明的候选集合解析（软校验：不可用不选，回退可用项并 WARN）
  const candidates = manager.styleCandidatesForStructure(def)
  const available = candidates.filter((c) => c.available)
  const requested = (instance && instance.styleTemplate) || def.styleTemplate
  const target = candidates.find((c) => c.fileKey === requested && c.available)
  let styleDef = null
  if (target) {
    styleDef = manager.findStyleTemplate(target.fileKey)
  } else if (available.length > 0) {
    styleDef = manager.findStyleTemplate(available[0].fileKey)
    const detail = candidates
      .map((c) => `${c.name}(${c.available ? '可用' : `缺 ${c.missingKeys.join('、')}`})`)
      .join('；')
    console.warn(
      `WARN: 样式「${requested || '(未指定)'}」不可用（候选：${detail}），回退为「${available[0].name}」`
    )
  } else {
    const detail = candidates
      .map((c) => `${c.name}(${c.missingKeys.join('、')})`)
      .join('；')
    return fail(`结构模板「${def.name}」无可用的样式模板：${detail}`)
  }
  console.log('Style:', styleDef.name, 'folder:', styleDef.docxFolder)

  const instructions = docx.serializeToInstructions(tree, styleDef)
  console.log('Instructions generated:', instructions.length)
  const result = await docx.writeDocx(instructions, styleDef, outputPath)
  console.log('Cloned list groups:', result.clonedGroups)
  console.log('SUCCESS:', result.outputPath)
}

main().catch((err) => {
  console.error('FAIL:', err)
  process.exitCode = 1
})
