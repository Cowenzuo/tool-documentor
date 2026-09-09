import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { resetIdCounterForTest } from '@documentor/core/idgen'
import type { DocumentTree, DocumentNode } from '@documentor/core/tree'
import { TemplateManager } from '@documentor/templates'
import { serializeToInstructions, serializeWithWarnings } from '../src/serializer'
import type { WriteInstruction } from '../src/instructions'
import { writeDocx } from '../src/writer'

const SAMPLE = fileURLToPath(new URL('../../../resources/test-fixtures/sample-template/', import.meta.url))
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'docx-test-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function crc32(buf: Buffer): number {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

/** 生成一张合法的最小 PNG（指定像素尺寸），用于验证图片嵌入 */
function makePng(w: number, h: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length, 0)
    const t = Buffer.from(type, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
    return Buffer.concat([len, t, data, crc])
  }
  // 每行：1 字节滤波 + w*3 字节 RGB
  const raw = Buffer.alloc(h * (1 + w * 3))
  const idat = deflateSync(raw)
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

function firstContentNode(tree: DocumentTree): DocumentNode {
  let found: DocumentNode | null = null
  tree.traverse((n) => {
    if (!found && n.allowContentBlocks && n.headingLevel > 0) found = n
  })
  if (!found) throw new Error('无可用内容节点')
  return found
}

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

  it('图片块：嵌入 media + rels + Content_Types + drawing（按像素计算显示尺寸）', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!

    // 2×3 像素 → 19050×28575 EMU（96 DPI）
    writeFileSync(join(dir, 'pic.png'), makePng(2, 3))
    const target = firstContentNode(tree)
    target.contentBlocks.push({ type: 'image', imagePath: 'pic.png', caption: '图1 测试图' })

    const { instructions } = serializeWithWarnings(tree, style, { imageBaseDir: dir })
    expect(instructions.some((i) => i.opType === 'InsertImage')).toBe(true)

    const outputPath = join(dir, 'out-img.docx')
    await writeDocx(instructions, style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    expect(Object.keys(zip.files)).toContain('word/media/image1.png')

    const documentXml = await zip.file('word/document.xml')!.async('string')
    expect(documentXml).toContain('<a:blip r:embed="rId1"/>')
    expect(documentXml).toContain('<wp:extent cx="19050" cy="28575"/>')
    expect(documentXml).toContain('<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">')
    // 图题仍在图下方
    expect(documentXml).toContain('测试图')

    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
    expect(rels).toContain(
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"'
    )
    const ct = await zip.file('[Content_Types].xml')!.async('string')
    expect(ct).toContain('<Default Extension="png" ContentType="image/png"/>')
  })

  it('图片段落套 figure 样式（样式表提供 figure 键时）', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const base = manager.styleForStructure(demo)!
    const style = { ...base, styleMap: { ...base.styleMap, figure: '119' } }

    writeFileSync(join(dir, 'pic-style.png'), makePng(2, 3))
    const target = firstContentNode(tree)
    target.contentBlocks.push({ type: 'image', imagePath: 'pic-style.png', caption: '图1 测试图' })

    const { instructions } = serializeWithWarnings(tree, style, { imageBaseDir: dir })
    const img = instructions.find(
      (i): i is Extract<WriteInstruction, { opType: 'InsertImage' }> => i.opType === 'InsertImage'
    )
    expect(img).toBeDefined()
    expect(img!.content.styleName).toBe('119')

    const outputPath = join(dir, 'out-img-style.docx')
    await writeDocx(instructions, style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')
    // pStyle 必须是 pPr 首个子元素，否则 Word 会忽略
    expect(documentXml).toContain(
      '<w:p><w:pPr><w:pStyle w:val="119"/><w:jc w:val="center"/></w:pPr><w:r><w:drawing>'
    )
  })

  it('表格纵向合并：同列连续相同内容 → vMerge restart/续格，表头不合并', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!

    const target = firstContentNode(tree)
    target.contentBlocks.push({
      type: 'table',
      caption: '表1 试验工况表',
      rows: 5,
      cols: 3,
      headers: ['序号', '工况模型', '试验工况'],
      data: [
        ['1', '上游1.5m-下游0.5m', '开度30%'],
        ['2', '上游1.5m-下游0.5m', '开度40%'],
        ['3', '上游1.5m-下游0.5m', '开度50%'],
        ['4', '上游1.5m-下游1m', '开度30%'],
        ['5', '上游1.5m-下游1m', '开度40%']
      ],
      mergeVertical: true
    })

    const instructions = serializeToInstructions(tree, style)
    const tbl = instructions.find(
      (i): i is Extract<WriteInstruction, { opType: 'InsertTable' }> => i.opType === 'InsertTable'
    )
    expect(tbl!.content.mergeVertical).toBe(true)

    const outputPath = join(dir, 'out-merge.docx')
    await writeDocx(instructions, style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')

    // 两组合并（3 行 + 2 行）：restart 2 个、续格 3 个、合并起点垂直居中 2 个
    expect(documentXml.match(/<w:vMerge w:val="restart"\/>/g)!).toHaveLength(2)
    expect(documentXml.match(/<w:vMerge\/>/g)!).toHaveLength(3)
    expect(documentXml.match(/<w:vAlign w:val="center"\/>/g)!).toHaveLength(2)
    // 合并内容只出现一次（续格留空段）
    expect(documentXml.match(/上游1\.5m-下游0\.5m/g)!).toHaveLength(1)
    // 表头行不参与合并：表头单元格里没有 vMerge
    const headerRow = /<w:tr>(?:(?!<\/w:tr>)[\s\S])*序号[\s\S]*?<\/w:tr>/.exec(documentXml)!
    expect(headerRow[0]).not.toContain('vMerge')
    // vMerge 必须在 tcW 之后
    expect(documentXml).toContain('<w:tcW w:w="3024" w:type="dxa"/><w:vMerge w:val="restart"/>')
  })

  it('表格未开启合并时不输出 vMerge', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!
    const target = firstContentNode(tree)
    target.contentBlocks.push({
      type: 'table',
      caption: '表1 重复值',
      rows: 2,
      cols: 1,
      headers: [],
      data: [['同值'], ['同值']]
    })
    const outputPath = join(dir, 'out-nomerge.docx')
    await writeDocx(serializeToInstructions(tree, style), style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')
    expect(documentXml).not.toContain('<w:vMerge')
  })

  it('无工程目录时回退占位文本（CLI/实例 JSON 路径）', () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!
    const target = firstContentNode(tree)
    target.contentBlocks.push({ type: 'image', imagePath: 'pic.png', caption: '图1 测试图' })
    const { instructions } = serializeWithWarnings(tree, style)
    expect(instructions.some((i) => i.opType === 'InsertImage')).toBe(false)
    expect(
      instructions.some(
        (i) => i.opType === 'InsertParagraph' && i.content.text.includes('[图片: pic.png]')
      )
    ).toBe(true)
  })
})
