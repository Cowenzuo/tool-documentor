/**
 * Documentor CLI：--test-export <instance.json> [out.docx]
 * 对齐旧版 main.cpp --test-export 语义：
 *  - 模板匹配：basedOn（结构模板名）→ styleTemplate（结构模板 styleTemplate 字段）→ 首模板（警告）
 *  - 无 instance 参数时用首个模板实例化空树（兼容旧行为）
 *  - 输出缺省：当前工作目录 test_output.docx
 * 用法：node cli/test-export.cjs <instance.json> [输出.docx]
 */
const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const { TemplateManager } = require('@documentor/templates')
const core = require('@documentor/core')
const docx = require('@documentor/docx')

function fail(msg) {
  console.error('FAIL:', msg)
  process.exitCode = 1
}

async function main() {
  const argv = process.argv.slice(2)
  let instancePath = ''
  if (argv[0] && argv[0].toLowerCase().endsWith('.json')) instancePath = argv[0]
  const outputPath = argv[1] || path.join(process.cwd(), 'test_output.docx')

  console.log('=== DOCX Export Test ===')

  // 模板目录：环境变量优先，否则内置资源
  const builtin = process.env.DOC_TEMPLATES_DIR || path.resolve(__dirname, '..', '..', '..', 'resources', 'templates')
  const manager = new TemplateManager()
  manager.loadTemplateDir(builtin)
  const structures = manager.listStructures()
  if (structures.length === 0) return fail(`cannot load templates from ${builtin}`)

  let def = null
  let tree = null

  if (instancePath) {
    if (!existsSync(instancePath)) return fail(`cannot open ${instancePath}`)
    console.log('Loading instance:', instancePath)
    let instance
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

  const styleDef = manager.styleForStructure(def)
  if (!styleDef) return fail('no style template for ' + def.name)
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
