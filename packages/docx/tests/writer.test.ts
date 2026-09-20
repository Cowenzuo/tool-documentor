/** writer.test.ts — 写入指令打包成 docx 的端到端单测。 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { resetIdCounterForTest } from '@documentor/core/idgen'
import { DocumentTree, DocumentNode } from '@documentor/core/tree'
import { TemplateManager } from '@documentor/templates'
import { serializeToInstructions, serializeWithWarnings } from '../src/serializer'
import type { WriteInstruction } from '../src/instructions'
import { writeDocx } from '../src/writer'

const SAMPLE = fileURLToPath(new URL('../../../samples/sample-template/', import.meta.url))
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

/** 取包含指定标记文本的那张表（模板本身可能也有表，不能按"第一张表"取） */
function tableAround(xml: string, marker: string): string {
  const at = xml.indexOf(marker)
  if (at < 0) throw new Error(`找不到标记：${marker}`)
  const start = xml.lastIndexOf('<w:tbl>', at)
  const end = xml.indexOf('</w:tbl>', at)
  if (start < 0 || end < 0) throw new Error(`标记不在表格里：${marker}`)
  return xml.slice(start, end + '</w:tbl>'.length)
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

    // 2×3 像素的极小图不放大（低于 150px 阈值）→ 保持原始尺寸 19050×28575 EMU（96 DPI）
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

  it('图片尺寸：铺满正文可用宽度并保持宽高比（不再写死 6 英寸）', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!

    // 示例骨架：A4 11906×16838 twips，左右边距各 1800 → 正文宽 8306 twips
    // = 8306 × 635 = 5,274,310 EMU
    writeFileSync(join(dir, 'wide.png'), makePng(400, 300))
    const target = firstContentNode(tree)
    target.contentBlocks.push({ type: 'image', imagePath: 'wide.png', caption: '图1 宽图' })

    const { instructions } = serializeWithWarnings(tree, style, { imageBaseDir: dir })
    const outputPath = join(dir, 'out-img-width.docx')
    await writeDocx(instructions, style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')

    const expectedCx = 8306 * 635
    const expectedCy = Math.round((300 * 9525 * expectedCx) / (400 * 9525))
    expect(documentXml).toContain(`<wp:extent cx="${expectedCx}" cy="${expectedCy}"/>`)
    // 旧口径（写死 6 英寸 = 5486400）已不再出现
    expect(documentXml).not.toContain('cx="5486400"')
    // 图片段落居中，且 pStyle 在 pPr 首位
    expect(documentXml).toContain('<w:jc w:val="center"/>')
  })

  it('图片尺寸：竖长图按页面高度上限缩放', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!

    // 200×4000 的竖长图：自然高度 4000×9525 EMU 远超可用高度
    // 可用高 = 16838-1440-1440 = 13958 twips × 635 = 8,863,330 EMU
    writeFileSync(join(dir, 'tall.png'), makePng(200, 4000))
    const target = firstContentNode(tree)
    target.contentBlocks.push({ type: 'image', imagePath: 'tall.png', caption: '图1 长图' })

    const { instructions } = serializeWithWarnings(tree, style, { imageBaseDir: dir })
    const outputPath = join(dir, 'out-img-tall.docx')
    await writeDocx(instructions, style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')

    const m = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(documentXml)!
    const cx = Number(m[1])
    const cy = Number(m[2])
    expect(cy).toBeLessThanOrEqual(13958 * 635)
    // 仍保持宽高比（1:20）
    expect(Math.abs(cy / cx - 20)).toBeLessThan(0.01)
  })

  it('图片格式：bmp/webp/svg/emf 都能读出真实尺寸，WebP/SVG 声明正确 MIME', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!

    // 导入对话框放行的八种格式里，png/jpg/gif 之外这四种以前一律按 800×520 渲染，
    // 宽高比被强制成 1.538，图在纸上会拉变形；webp/svg 还会被声明成 octet-stream 而不显示。
    const bmp = Buffer.alloc(54)
    bmp.write('BM', 0, 'ascii')
    bmp.writeUInt32LE(40, 14)
    bmp.writeInt32LE(300, 18)
    bmp.writeInt32LE(100, 22)
    writeFileSync(join(dir, 'size.bmp'), bmp)

    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'ascii')
    webp.write('WEBP', 8, 'ascii')
    webp.write('VP8X', 12, 'ascii')
    const vw = 320 - 1
    const vh = 160 - 1
    webp[24] = vw & 0xff
    webp[25] = (vw >> 8) & 0xff
    webp[26] = (vw >> 16) & 0xff
    webp[27] = vh & 0xff
    webp[28] = (vh >> 8) & 0xff
    webp[29] = (vh >> 16) & 0xff
    writeFileSync(join(dir, 'size.webp'), webp)

    writeFileSync(
      join(dir, 'size.svg'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><rect/></svg>'
    )

    const emf = Buffer.alloc(40)
    emf.writeUInt32LE(1, 0)
    emf.writeInt32LE(0, 8)
    emf.writeInt32LE(0, 12)
    emf.writeInt32LE(1000, 16)
    emf.writeInt32LE(400, 20)
    emf.writeInt32LE(0, 24)
    emf.writeInt32LE(0, 28)
    emf.writeInt32LE(25400, 32) // rclFrame，单位 0.01 毫米 → 254mm → 960px
    emf.writeInt32LE(12700, 36) // 127mm → 480px
    writeFileSync(join(dir, 'size.emf'), emf)

    const cases: Array<{ file: string; ratio: number; mime?: string }> = [
      { file: 'size.bmp', ratio: 100 / 300 },
      { file: 'size.webp', ratio: 160 / 320, mime: 'image/webp' },
      { file: 'size.svg', ratio: 50 / 200, mime: 'image/svg+xml' },
      { file: 'size.emf', ratio: 480 / 960 }
    ]

    for (const item of cases) {
      const caseTree = loadDemo().tree
      const node = firstContentNode(caseTree)
      node.contentBlocks.push({ type: 'image', imagePath: item.file, caption: `图1 ${item.file}` })
      const outputPath = join(dir, `out-${item.file}.docx`)
      const { instructions } = serializeWithWarnings(caseTree, style, { imageBaseDir: dir })
      await writeDocx(instructions, style, outputPath)
      const zip = await JSZip.loadAsync(readFileSync(outputPath))
      const documentXml = await zip.file('word/document.xml')!.async('string')
      const m = /<wp:extent cx="(\d+)" cy="(\d+)"\/>/.exec(documentXml)!
      expect(m, `${item.file} 应有 wp:extent`).toBeTruthy()
      const ratio = Number(m[2]) / Number(m[1])
      expect(Math.abs(ratio - item.ratio), `${item.file} 宽高比`).toBeLessThan(0.01)
      if (item.mime) {
        const ct = await zip.file('[Content_Types].xml')!.async('string')
        expect(ct).toContain(`ContentType="${item.mime}"`)
      }
    }
  })

  it('图片路径兼容：块里只记文件名时回落工程 images/ 目录', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!
    const target = firstContentNode(tree)

    // 早期版本把 imagePath 记成裸文件名，而文件实际落在工程 images/ 下；
    // 这类历史数据不能再降级成占位文本。
    mkdirSync(join(dir, 'images'), { recursive: true })
    writeFileSync(join(dir, 'images', 'legacy.png'), makePng(200, 100))
    target.contentBlocks.push({ type: 'image', imagePath: 'legacy.png', caption: '图1 历史路径' })

    const { instructions } = serializeWithWarnings(tree, style, { imageBaseDir: dir })
    const img = instructions.find(
      (i): i is Extract<WriteInstruction, { opType: 'InsertImage' }> => i.opType === 'InsertImage'
    )
    expect(img).toBeDefined()
    expect(img!.content.srcPath).toBe(join(dir, 'images', 'legacy.png'))
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

  it('正文行数以 data 为准：rows 偏小不得丢掉行尾数据', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!
    const target = firstContentNode(tree)

    // 故意把 rows 写成 2（比如误按"数据行 + 表头"的口径），data 实际 4 行。
    // 旧实现取 min(rows, data.length) 会静默丢掉后两行——这正是要钉住的缺陷。
    target.contentBlocks.push({
      type: 'table',
      caption: '表1 rows 与 data 不一致',
      rows: 2,
      cols: 2,
      headers: ['标识', '说明'],
      data: [
        ['R1', '第一行'],
        ['R2', '第二行'],
        ['R3', '第三行'],
        ['R4', '第四行']
      ]
    })

    const outputPath = join(dir, 'out-rows-mismatch.docx')
    await writeDocx(serializeToInstructions(tree, style), style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')

    for (const cell of ['R1', 'R2', 'R3', 'R4']) {
      expect(documentXml).toContain(`>${cell}<`)
    }
    // 表头 1 行 + 数据 4 行 = 5 行
    const table = /<w:tbl>(?:(?!<\/w:tbl>)[\s\S])*?rows 与 data 不一致(?:(?!<\/w:tbl>)[\s\S])*?<\/w:tbl>/.exec(
      documentXml
    )
    if (table) {
      expect(table[0].match(/<w:tr>/g)!).toHaveLength(5)
    }
  })

  it('表格列数以 data 为准：cols 偏小不得丢掉右边几列', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!
    const target = firstContentNode(tree)

    // 模板/实例 JSON 不给 cols 时它是 0；旧实现按 max(1, cols) 只渲染 1 列，
    // 后面几列静默消失（与 rows 那条是同一类缺陷）。
    target.contentBlocks.push({
      type: 'table',
      caption: '表1 cols 偏小',
      rows: 2,
      cols: 0,
      headers: ['A', 'B', 'C'],
      data: [
        ['a1', 'b1', 'c1'],
        ['a2', 'b2', 'c2']
      ]
    })

    const outputPath = join(dir, 'out-cols-mismatch.docx')
    await writeDocx(serializeToInstructions(tree, style), style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')

    for (const cellText of ['A', 'B', 'C', 'a1', 'b1', 'c1', 'a2', 'b2', 'c2']) {
      expect(documentXml).toContain(`>${cellText}<`)
    }
    const table = tableAround(documentXml, '>a1<')
    expect(table.match(/<w:gridCol /g)!).toHaveLength(3)
    expect(table.match(/<w:tr>/g)!).toHaveLength(3)
    expect(table.match(/<w:tc>/g)!).toHaveLength(9)
  })

  it('表头 3 列、数据行 2 列时，第 3 列上的显式跨度不得被丢弃', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!
    const target = firstContentNode(tree)

    // 缺陷现场：判定原先只按数据行宽度算列数（2 列），第 3 列（下标 2）的跨度
    // 被当成越界丢掉，预览与导出都少一处合并。导出侧列数取"表头、每行、cols"
    // 的最大值，判定必须同口径，否则这一个合并只有导出丢。
    target.contentBlocks.push({
      type: 'table',
      caption: '表1 表头比数据行宽',
      rows: 2,
      cols: 3,
      headers: ['序号', '标识', '标题'],
      data: [
        ['1', '补齐-001'],
        ['2', '补齐-002']
      ],
      rowSpans: { '2': [[0, 2]] }
    })

    const outputPath = join(dir, 'out-span-third-col.docx')
    await writeDocx(serializeToInstructions(tree, style), style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')

    const table = tableAround(documentXml, '>补齐-001<')
    expect(table.match(/<w:gridCol /g)!).toHaveLength(3)
    // 第 3 列第 1 行是合并起点，第 2 行是续格；总共各一处
    expect(table.match(/<w:vMerge w:val="restart"\/>/g)!).toHaveLength(1)
    expect(table.match(/<w:vMerge\/>/g)!).toHaveLength(1)
    const firstRow = /<w:tr>(?:(?!<\/w:tr>)[\s\S])*?补齐-001(?:(?!<\/w:tr>)[\s\S])*?<\/w:tr>/.exec(table)!
    const firstCells = firstRow[0].match(/<w:tc>[\s\S]*?<\/w:tc>/g)!
    expect(firstCells).toHaveLength(3)
    expect(firstCells[0]).not.toContain('vMerge')
    expect(firstCells[1]).not.toContain('vMerge')
    expect(firstCells[2]).toContain('<w:vMerge w:val="restart"/>')
    const secondRow = /<w:tr>(?:(?!<\/w:tr>)[\s\S])*?补齐-002(?:(?!<\/w:tr>)[\s\S])*?<\/w:tr>/.exec(table)!
    const secondCells = secondRow[0].match(/<w:tc>[\s\S]*?<\/w:tc>/g)!
    expect(secondCells).toHaveLength(3)
    expect(secondCells[2]).toContain('<w:vMerge/>')
  })

  it('表格参差行补齐到列数，行内单元格数与 tblGrid 一致', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!
    const target = firstContentNode(tree)

    target.contentBlocks.push({
      type: 'table',
      caption: '表1 参差行',
      rows: 2,
      cols: 3,
      headers: [],
      data: [
        ['r1c1', 'r1c2', 'r1c3'],
        ['r2c1']
      ]
    })

    const outputPath = join(dir, 'out-ragged-rows.docx')
    await writeDocx(serializeToInstructions(tree, style), style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')
    const table = tableAround(documentXml, '>r1c1<')
    expect(table.match(/<w:tc>/g)!).toHaveLength(6)
  })

  it('XML 非法控制字符在写入前清掉，不产出打不开的文档', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!
    const target = firstContentNode(tree)
    // 粘贴终端输出会带 ANSI 转义（ESC）、PDF 复制会带 \f、\v
    target.contentBlocks.push({ type: 'text', content: '前\u0000\u001b[31m中\f\u000b后\u001f' })

    const outputPath = join(dir, 'out-ctrl-chars.docx')
    await writeDocx(serializeToInstructions(tree, style), style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')

    expect(documentXml).toContain('前')
    expect(documentXml).toContain('中')
    expect(documentXml).toContain('后')
    // XML 1.0 不允许的码位一个都不能留（\t\n\r 除外）
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(documentXml)).toBe(false)
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

  it('题注域：STYLEREF + SEQ 并写入缓存值（field 模式）', async () => {
    resetIdCounterForTest()
    const { manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const base = manager.styleForStructure(demo)!
    const style = {
      ...base,
      headingStarts: [4, 1, 1, 1, 1],
      captionNumbering: { table: 'field' as const, chapterStyleNames: { '1': '标题 1' } }
    }
    // 受控树：一个标题 1 节点 + 一张带手写表号的表
    const root = new DocumentNode(0)
    const h1 = new DocumentNode(1)
    h1.title = '第四章'
    h1.contentBlocks.push({
      type: 'table',
      caption: '表4.1-1 试验工况表',
      rows: 1,
      cols: 1,
      headers: ['A'],
      data: [['1']]
    })
    root.addChild(h1)

    const outputPath = join(dir, 'out-caption-field.docx')
    await writeDocx(serializeToInstructions(new DocumentTree(root), style), style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')

    expect(documentXml).toContain(
      '<w:r><w:t>表</w:t></w:r>' +
        '<w:fldSimple w:instr=" STYLEREF &quot;标题 1&quot; \\n "><w:r><w:t>4</w:t></w:r></w:fldSimple>' +
        '<w:r><w:t>-</w:t></w:r>' +
        '<w:fldSimple w:instr=" SEQ 表 \\* ARABIC \\s 1 "><w:r><w:t>1</w:t></w:r></w:fldSimple>'
    )
    // 手写表号已剥离，题注样式沿用 table.caption
    expect(documentXml).toContain('<w:pStyle w:val="48"/>')
    expect(documentXml).not.toContain('表4.1-1')
    expect(documentXml).toContain('<w:t xml:space="preserve"> 试验工况表</w:t>')
  })

  it('题注域：chapterStyleNames 显式空串时章节号写成文本（不做 STYLEREF）', async () => {
    resetIdCounterForTest()
    const { manager } = loadDemo()
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const base = manager.styleForStructure(demo)!
    const style = {
      ...base,
      headingStarts: [4, 1, 1, 1, 1],
      captionNumbering: { table: 'field' as const, chapterStyleNames: { '1': '' } }
    }
    const root = new DocumentNode(0)
    const h1 = new DocumentNode(1)
    h1.title = '第四章'
    h1.contentBlocks.push({
      type: 'table',
      caption: '表4.1-1 试验工况表',
      rows: 1,
      cols: 1,
      headers: ['A'],
      data: [['1']]
    })
    root.addChild(h1)
    const outputPath = join(dir, 'out-caption-plain.docx')
    await writeDocx(serializeToInstructions(new DocumentTree(root), style), style, outputPath)
    const zip = await JSZip.loadAsync(readFileSync(outputPath))
    const documentXml = await zip.file('word/document.xml')!.async('string')
    expect(documentXml).not.toContain('STYLEREF')
    expect(documentXml).toMatch(/<w:r><w:t>表<\/w:t><\/w:r><w:r><w:t>4<\/w:t><\/w:r>/)
    expect(documentXml).toContain('SEQ 表')
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
