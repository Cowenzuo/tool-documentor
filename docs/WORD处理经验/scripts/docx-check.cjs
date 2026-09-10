/**
 * docx-check.cjs — 不开 Word，直接读 docx 包核对：媒体、关系、域、合并、题注样式。
 *
 * 用法：
 *   node docs/WORD处理经验/scripts/docx-check.cjs <出.docx>
 *
 * 看点：
 *   - 媒体文件数、图片关系数与 <w:drawing> 段数三者应一致；
 *   - 题注数量应等于 域数 除以 2，每个题注由 STYLEREF 与 SEQ 各一个域组成；
 *   - 图片段落样式分布能一次看出有没有段落漏了样式；
 *   - 纵向合并的起点数与续格数能对上工程里预告的合并处数。
 *
 * 依赖：jszip 从 packages/docx 的依赖里取，脚本自身不额外装包。
 */
const { readFileSync, existsSync } = require('node:fs')
const { join, dirname, resolve } = require('node:path')
const { createRequire } = require('node:module')

/** 从脚本位置往上找仓库根：认 pnpm-workspace.yaml */
function findRepoRoot(start) {
  let dir = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('未找到仓库根，脚本要从仓库内运行')
}

const target = process.argv[2]
if (!target) {
  console.error('用法：node docs/WORD处理经验/scripts/docx-check.cjs <出.docx>')
  process.exit(1)
}

const ROOT = findRepoRoot(__dirname)
const JSZip = createRequire(join(ROOT, 'packages', 'docx', 'package.json'))('jszip')

function count(text, re) {
  return [...text.matchAll(re)].length
}

async function main() {
  const docxPath = resolve(target)
  const zip = await JSZip.loadAsync(readFileSync(docxPath))
  const names = Object.keys(zip.files)
  const media = names.filter((f) => f.startsWith('word/media/') && !zip.files[f].dir)
  const doc = await zip.file('word/document.xml').async('string')
  const relsEntry = zip.file('word/_rels/document.xml.rels')
  const rels = relsEntry ? await relsEntry.async('string') : ''
  const ct = await zip.file('[Content_Types].xml').async('string')

  const drawings = count(doc, /<w:drawing>/g)
  const blips = count(doc, /<a:blip /g)
  const imageRels = count(rels, /relationships\/image/g)
  const fields = count(doc, /<w:fldSimple /g)
  const styleRefs = count(doc, /STYLEREF/g)
  const seqs = count(doc, /SEQ /g)
  const mergeStart = count(doc, /<w:vMerge w:val="restart"\/>/g)
  const mergeCont = count(doc, /<w:vMerge\/>/g)
  const placeholders = count(doc, /\[图片: /g)
  const tables = count(doc, /<w:tbl>/g)

  const embedIds = new Set([...doc.matchAll(/<a:blip r:embed="([^"]+)"/g)].map((m) => m[1]))
  const relIds = new Set([...rels.matchAll(/Id="([^"]+)"[^>]*relationships\/image/g)].map((m) => m[1]))
  const dangling = [...embedIds].filter((id) => !relIds.has(id))

  const styleCount = new Map()
  for (const p of doc.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    if (!/<w:drawing>/.test(p[0])) continue
    const st = /<w:pStyle w:val="([^"]+)"/.exec(p[0])
    const key = st ? st[1] : '(无 pStyle)'
    styleCount.set(key, (styleCount.get(key) ?? 0) + 1)
  }

  console.log('文件        : ' + docxPath)
  console.log('体积        : ' + (readFileSync(docxPath).length / 1024 / 1024).toFixed(1) + ' MB')
  console.log('媒体文件    : ' + media.length)
  console.log('图片        : drawing=' + drawings + ' blip=' + blips + ' 关系=' + imageRels)
  console.log('引用缺失    : ' + (dangling.length ? dangling.join(',') : '无'))
  console.log('图片占位残留: ' + placeholders)
  console.log('图片段落样式: ' + JSON.stringify([...styleCount]))
  console.log('表格        : ' + tables + ' 张')
  console.log('纵向合并    : 起点=' + mergeStart + ' 续格=' + mergeCont)
  console.log('域          : 合计=' + fields + ' STYLEREF=' + styleRefs + ' SEQ=' + seqs)
  console.log('图片类型声明: ' + (/Extension="png"/i.test(ct) ? 'png 已声明' : 'png 未声明'))
}

main().catch((err) => {
  console.error('FAIL: ' + err.message)
  process.exit(1)
})
