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

const SAMPLE = fileURLToPath(new URL('../../../resources/test-fixtures/sample-template/', import.meta.url))
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'docx-test-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function loadDemo(): { manager: TemplateManager; tree: DocumentTree } {
  const manager = new TemplateManager()
  manager.loadTemplateDir(SAMPLE)
  const demo = manager.findStructureByName('示例文档模板 (Demo)')
  const style = demo && manager.styleForStructure(demo)
  const tree = demo && manager.instantiate(demo)
  if (!demo || !style || !tree) throw new Error('示例模板加载失败')
  return { manager, tree }
}

describe('DocxWriter 端到端（合成示例模板骨架）', () => {
  it('导出 docx：正文/样式/题注剥离/列表克隆/表格结构', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!

    const instructions = serializeToInstructions(tree, style)
    const outputPath = join(dir, 'out.docx')
    const result = await writeDocx(instructions, style, outputPath)
    expect(existsSync(outputPath)).toBe(true)
    expect(result.clonedGroups).toBeGreaterThanOrEqual(2)

    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const names = Object.keys(zip.files)
    for (const required of [
      '[Content_Types].xml',
      '_rels/.rels',
      'word/styles.xml',
      'word/numbering.xml',
      'word/document.xml'
    ]) {
      expect(names).toContain(required)
    }

    const documentXml = await zip.file('word/document.xml')!.async('string')
    expect(documentXml).toContain('<w:pStyle w:val="49"/>')
    expect(documentXml).toContain('<w:pStyle w:val="50"/>')
    expect(documentXml).toContain('<w:pStyle w:val="45"/>')
    // 表题注（剥离"表1 "）与表格边框规则
    expect(documentXml).toContain('示例引用')
    expect(documentXml).not.toContain('表1 示例引用')
    expect(documentXml).toContain('<w:tblBorders>')
    expect(documentXml).toContain('w:sz="8"')
    expect(documentXml).toContain('w:sz="4"')
    // sectPr 保留
    expect(documentXml).toContain('<w:sectPr')
    expect(documentXml.trim().endsWith('</w:document>')).toBe(true)
    expect(documentXml.match(/<w:document /g)).toHaveLength(1)
    // mc:Ignorable 引用的前缀必须已声明（否则 Word 拒绝打开）
    expect(documentXml).toContain('xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"')
    expect(documentXml).toContain('mc:Ignorable="w14 w15 wp14"')

    // numbering 克隆
    const numberingXml = await zip.file('word/numbering.xml')!.async('string')
    expect(numberingXml.match(/<w:num w:numId="(20[0-9])"/g)!.length).toBe(result.clonedGroups)
    expect(numberingXml).toMatch(/w:nsid w:val="[A-F0-9]{8}"/)
  })

  it('骨架文件逐字节保留（除 document/numbering）', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!
    const outputPath = join(dir, 'out2.docx')
    await writeDocx(serializeToInstructions(tree, style), style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    for (const rel of ['word/styles.xml', '[Content_Types].xml']) {
      const produced = await zip.file(rel)!.async('nodebuffer')
      const original = readFileSync(join(style.skeletonPath, rel))
      expect(Buffer.compare(produced, original)).toBe(0)
    }
  })

  it('空正文文档也能导出（纯标题树）', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    tree.root.children = []
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!
    const outputPath = join(dir, 'out3.docx')
    await writeDocx(serializeToInstructions(tree, style), style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')
    expect(documentXml).toContain('<w:sectPr')
  })
})
