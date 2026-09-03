import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { resetIdCounterForTest } from '@documentor/core/idgen'
import type { DocumentTree } from '@documentor/core/tree'
import { TemplateManager } from '@documentor/templates'
import { serializeToInstructions } from '../src/serializer'
import { writeDocx } from '../src/writer'

const BUILTIN = fileURLToPath(new URL('../../../resources/templates/', import.meta.url))
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'docx-test-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function loadSrs(): { manager: TemplateManager; tree: DocumentTree } {
  const manager = new TemplateManager()
  manager.loadTemplateDir(BUILTIN)
  const srs = manager.findStructureByName('438C-软件需求规格说明(SRS)')
  const style = srs && manager.styleForStructure(srs)
  const tree = srs && manager.instantiate(srs)
  if (!srs || !style || !tree) throw new Error('SRS 模板加载失败')
  return { manager, tree }
}

describe('DocxWriter 端到端（真实 438C-SRS 骨架）', () => {
  it('导出 docx：正文/样式/题注剥离/列表克隆/表格结构', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadSrs()
    const srs = manager.findStructureByName('438C-软件需求规格说明(SRS)')!
    const style = manager.styleForStructure(srs)!

    const instructions = serializeToInstructions(tree, style)
    const outputPath = join(dir, 'out.docx')
    const result = await writeDocx(instructions, style, outputPath)
    expect(existsSync(outputPath)).toBe(true)
    expect(result.clonedGroups).toBeGreaterThanOrEqual(1)

    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const names = Object.keys(zip.files)
    // 骨架部件齐备
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/styles.xml',
      'word/numbering.xml',
      'word/settings.xml',
      'word/document.xml',
      'word/theme/theme1.xml'
    ]) {
      expect(names).toContain(required)
    }

    const documentXml = await zip.file('word/document.xml')!.async('string')
    // 标题段落使用骨架 styleId
    expect(documentXml).toContain('<w:pStyle w:val="49"/>')
    expect(documentXml).toContain('<w:pStyle w:val="50"/>')
    // 正文样式
    expect(documentXml).toContain('<w:pStyle w:val="45"/>')
    // 表题注（剥离"表1 "）与表格边框规则
    expect(documentXml).toContain('引用文档')
    expect(documentXml).not.toContain('表1 引用文档')
    expect(documentXml).toContain('<w:tblBorders>')
    expect(documentXml).toContain('w:sz="8"')
    expect(documentXml).toContain('w:sz="4"')
    // sectPr 保留
    expect(documentXml).toContain('<w:sectPr')
    expect(documentXml.trim().endsWith('</w:document>')).toBe(true)
    // 根元素仅一处 w:document
    expect(documentXml.match(/<w:document /g)).toHaveLength(1)
    // 转义检查：模板含 & 等文本较少，直接注入断言在 serializer 单测内做

    // numbering 克隆
    const numberingXml = await zip.file('word/numbering.xml')!.async('string')
    expect(numberingXml.match(/<w:num w:numId="(20[0-9])"/g)!.length).toBe(result.clonedGroups)
    // 新 abstractNum 的 nsid 已重写（与原始不同即可，值为大写 hex 8 位）
    expect(numberingXml).toMatch(/w:nsid w:val="[A-F0-9]{8}"/)
  })

  it('骨架文件逐字节保留（除 document/numbering）', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadSrs()
    const srs = manager.findStructureByName('438C-软件需求规格说明(SRS)')!
    const style = manager.styleForStructure(srs)!
    const outputPath = join(dir, 'out2.docx')
    await writeDocx(serializeToInstructions(tree, style), style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    for (const rel of ['word/styles.xml', 'word/settings.xml', '[Content_Types].xml', 'docProps/core.xml']) {
      const produced = await zip.file(rel)!.async('nodebuffer')
      const original = readFileSync(join(style.skeletonPath, rel))
      expect(Buffer.compare(produced, original)).toBe(0)
    }
  })

  it('空正文文档也能导出（纯标题树）', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadSrs()
    // 清空全部内容块与子节点保留根
    tree.root.children = []
    const srs = manager.findStructureByName('438C-软件需求规格说明(SRS)')!
    const style = manager.styleForStructure(srs)!
    const outputPath = join(dir, 'out3.docx')
    await writeDocx(serializeToInstructions(tree, style), style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')
    expect(documentXml).toContain('<w:sectPr')
  })
})
