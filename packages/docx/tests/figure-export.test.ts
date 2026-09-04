/**
 * figure-export.test.ts — M7 编排层（注入假转换器，无需 mmd2vsdx/Visio）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { resetIdCounterForTest } from '@documentor/core/idgen'
import { TemplateManager } from '@documentor/templates'
import type { DocumentTree, DocumentNode } from '@documentor/core/tree'
import { parseCompoundFile } from '@documentor/postprocess'
import { exportTreeToDocx, attachFiguresToDocx, exportTreeToDocxWithFigures } from '../src/index'

const SAMPLE = fileURLToPath(new URL('../../../resources/test-fixtures/sample-template/', import.meta.url))
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'docx-fig-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function loadDemo(): { manager: TemplateManager; tree: DocumentTree } {
  const manager = new TemplateManager()
  manager.loadTemplateDir(SAMPLE)
  const demo = manager.findStructureByName('示例文档模板 (Demo)')
  const tree = demo && manager.instantiate(demo)
  if (!demo || !tree) throw new Error('示例模板加载失败')
  return { manager, tree }
}

/** 找一个允许内容块的节点并塞入 Mermaid 块（若实例已有则不再加） */
function addMermaid(tree: DocumentTree): number {
  const count = (n: DocumentNode): number =>
    n.contentBlocks.filter((b) => b.type === 'mermaid' && b.code.length > 0).length +
    n.children.reduce((s, c) => s + count(c), 0)
  if (count(tree.root) > 0) {
    // 模板实例自带 Mermaid（如 demo）：直接用，不重复添加
    const exists = (n: DocumentNode): boolean =>
      n.contentBlocks.some((b) => b.type === 'mermaid') || n.children.some(exists)
    if (!exists(tree.root)) throw new Error('addMermaid: 逻辑异常')
    return count(tree.root)
  }
  const visit = (node: DocumentNode): DocumentNode | null => {
    if (node.allowContentBlocks) return node
    for (const child of node.children) {
      const found = visit(child)
      if (found) return found
    }
    return null
  }
  const target = visit(tree.root)
  if (!target) throw new Error('示例模板无允许内容块的节点')
  target.contentBlocks.push({ type: 'mermaid', caption: '图1 结构', code: 'graph TD\nA-->B' })
  return 1
}

/** 清掉实例中的全部 Mermaid 块（用于“无图块”用例） */
function stripMermaids(tree: DocumentTree): void {
  const walk = (node: DocumentNode): void => {
    node.contentBlocks = node.contentBlocks.filter((b) => b.type !== 'mermaid')
    for (const child of node.children) walk(child)
  }
  walk(tree.root)
}

/** 合成 vsdx（含形状 → bbox 可求 + 页面尺寸可修补） */
async function makeVsdx(): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('visio/pages/page1.xml',
    '<PageContents><Shapes>' +
    '<Shape ID="1"><Cell N="PinX" V="25" U="MM"/><Cell N="PinY" V="30" U="MM"/><Cell N="Width" V="40" U="MM"/><Cell N="Height" V="20" U="MM"/></Shape>' +
    '<Shape ID="2"><Cell N="PinX" V="100" U="MM"/><Cell N="PinY" V="80" U="MM"/><Cell N="Width" V="50" U="MM"/><Cell N="Height" V="30" U="MM"/></Shape>' +
    '</Shapes></PageContents>')
  zip.file('visio/pages/pages.xml',
    '<PageSheet><Cell N="PageWidth" V="210" U="MM"/><Cell N="PageHeight" V="297" U="MM"/></PageSheet>')
  return zip.generateAsync({ type: 'uint8array' })
}

describe('attachFiguresToDocx（注入转换器）', () => {
  it('embed 模式：占位 → OLE 对象，输出 -嵌入.docx，统计正确', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const expectedTotal = addMermaid(tree)
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!

    const basePath = join(dir, 'plain.docx')
    await exportTreeToDocx(tree, style, basePath)

    const vsdx = await makeVsdx()
    const result = await attachFiguresToDocx(basePath, tree, style, {
      convert: async () => ({ ok: true, vsdxBase64: Buffer.from(vsdx).toString('base64') })
    })

    expect(result.outputPath).toBe(join(dir, 'plain-嵌入.docx'))
    expect(existsSync(result.outputPath)).toBe(true)
    expect(result.figureStats.total).toBe(expectedTotal)
    expect(result.figureStats.converted).toBe(expectedTotal)
    expect(result.figureStats.embedded).toBe(expectedTotal)
    expect(result.figureStats.previewCount).toBe(0)
    expect(result.figureStats.failed).toEqual([])

    const zip = await JSZip.loadAsync(readFileSync(result.outputPath))
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).not.toContain('[Mermaid')
    expect(doc).toContain('<o:OLEObject Type="Embed" ProgID="Visio.Drawing.15"')
    const ole = await zip.file('word/embeddings/oleObject1.bin')!.async('uint8array')
    const cfb = parseCompoundFile(ole)
    expect(cfb['Package']!.length).toBeGreaterThan(0)
  })

  it('上游附带预览（previewBase64 png）：嵌入 v:imagedata + media/image1.png', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const expectedTotal = addMermaid(tree)
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!

    const basePath = join(dir, 'plain2.docx')
    await exportTreeToDocx(tree, style, basePath)

    const vsdx = await makeVsdx()
    const result = await attachFiguresToDocx(basePath, tree, style, {
      convert: async () => ({
        ok: true,
        vsdxBase64: Buffer.from(vsdx).toString('base64'),
        previewBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03]).toString('base64'),
        previewExt: 'png'
      })
    })

    expect(result.figureStats.previewCount).toBe(expectedTotal)
    expect(result.figureStats.embedded).toBe(expectedTotal)
    const zip = await JSZip.loadAsync(readFileSync(result.outputPath))
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).toContain('<v:imagedata r:id="rId')
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
    expect(rels).toContain('Target="media/image1.png"')
    const ct = await zip.file('[Content_Types].xml')!.async('string')
    expect(ct).toContain('<Default Extension="png" ContentType="image/png"/>')
  })

  it('暂存区同名 png 回退：转换未返回预览但 <stem>.png 存在 → 仍嵌入预览', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const expectedTotal = addMermaid(tree)
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!

    const basePath = join(dir, 'plain2b.docx')
    await exportTreeToDocx(tree, style, basePath)
    const stagingDir = mkdtempSync(join(tmpdir(), 'docx-staging-'))

    const vsdx = await makeVsdx()
    const result = await attachFiguresToDocx(basePath, tree, style, {
      stagingDir,
      convert: async (code, caption) => {
        // 模拟“转换后另存同名 .png”（外部预览文件流程）
        const name = `sdd-001-${caption.replace(/^图\d+\s*/, '')}.png`
        writeFileSync(join(stagingDir, name), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01]))
        return { ok: true, vsdxBase64: Buffer.from(vsdx).toString('base64') }
      }
    })

    expect(result.figureStats.previewCount).toBe(expectedTotal)
    const zip = await JSZip.loadAsync(readFileSync(result.outputPath))
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).toContain('<v:imagedata r:id="rId')
  })

  it('无预览物：嵌入仍然成功（Word 显示 OLE 图标），previewCount=0', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    addMermaid(tree)
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!

    const basePath = join(dir, 'plain2c.docx')
    await exportTreeToDocx(tree, style, basePath)

    const vsdx = await makeVsdx()
    const result = await attachFiguresToDocx(basePath, tree, style, {
      convert: async () => ({ ok: true, vsdxBase64: Buffer.from(vsdx).toString('base64') })
    })
    expect(result.figureStats.previewCount).toBe(0)
    expect(result.figureStats.embedded).toBe(1)
    const zip = await JSZip.loadAsync(readFileSync(result.outputPath))
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).toContain('<o:OLEObject')
    expect(doc).not.toContain('<v:imagedata')
  })

  it('转换失败：保留占位文本 + failed 明细', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    const expectedTotal = addMermaid(tree)
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!

    const basePath = join(dir, 'plain3.docx')
    await exportTreeToDocx(tree, style, basePath)

    const result = await attachFiguresToDocx(basePath, tree, style, {
      convert: async () => ({ ok: false, error: 'mermaid 语法错误' })
    })
    expect(result.figureStats.converted).toBe(0)
    expect(result.figureStats.embedded).toBe(0)
    expect(result.figureStats.failed).toHaveLength(expectedTotal)
    expect(result.figureStats.failed[0]!.reason).toContain('mermaid 语法错误')
    const zip = await JSZip.loadAsync(readFileSync(result.outputPath))
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).toContain('[Mermaid')
  })

  it('无 Mermaid 块：原路径返回，不产出对象段', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    stripMermaids(tree)
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!

    const basePath = join(dir, 'plain4.docx')
    await exportTreeToDocx(tree, style, basePath)
    const result = await attachFiguresToDocx(basePath, tree, style, {})
    expect(result.outputPath).toBe(basePath)
    expect(result.warnings.some((w) => w.includes('没有 Mermaid 图块'))).toBe(true)
  })
})

describe('exportTreeToDocxWithFigures（一键导出，交付=所给路径）', () => {
  it('嵌入成功：最终产物在 outputPath，占位中间文件清理', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    addMermaid(tree)
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!
    const finalPath = join(dir, 'one-shot.docx')

    const vsdx = await makeVsdx()
    const result = await exportTreeToDocxWithFigures(tree, style, finalPath, {
      convert: async () => ({ ok: true, vsdxBase64: Buffer.from(vsdx).toString('base64') })
    })

    expect(result.outputPath).toBe(finalPath)
    expect(result.figureStats.embedded).toBeGreaterThanOrEqual(1)
    expect(existsSync(finalPath)).toBe(true)
    // 无占位中间文件残留
    expect(existsSync(join(dir, 'one-shot-占位.tmp.docx'))).toBe(false)
    const zip = await JSZip.loadAsync(readFileSync(finalPath))
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).toContain('<o:OLEObject Type="Embed" ProgID="Visio.Drawing.15"')
  })

  it('无 Mermaid：占用版也写入所给路径（不落 -嵌入 别处）', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    stripMermaids(tree)
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!
    const finalPath = join(dir, 'one-shot-empty.docx')

    const result = await exportTreeToDocxWithFigures(tree, style, finalPath, {
      convert: async () => ({ ok: true, vsdxBase64: Buffer.from(await makeVsdx()).toString('base64') })
    })

    expect(result.outputPath).toBe(finalPath)
    expect(result.figureStats.total).toBe(0)
    expect(result.warnings.some((w) => w.includes('没有 Mermaid 图块'))).toBe(true)
    expect(existsSync(finalPath)).toBe(true)
    expect(existsSync(join(dir, 'one-shot-empty-占位.tmp.docx'))).toBe(false)
  })

  it('mmd2vsdx 加载失败：自动降级为占位版写入所给路径 + 警告（不中断导出）', async () => {
    resetIdCounterForTest()
    const { tree, manager } = loadDemo()
    addMermaid(tree)
    const demo = manager.findStructureByName('示例文档模板 (Demo)')!
    const style = manager.styleForStructure(demo)!
    const finalPath = join(dir, 'degrade.docx')

    const result = await exportTreeToDocxWithFigures(tree, style, finalPath, {
      loadConverter: async () => {
        throw new Error('mmd2vsdx 模块不可用')
      }
    })

    expect(result.outputPath).toBe(finalPath)
    expect(existsSync(finalPath)).toBe(true)
    expect(result.figureStats.converted).toBe(0)
    expect(result.figureStats.embedded).toBe(0)
    expect(result.warnings.some((w) => w.includes('图嵌入不可用'))).toBe(true)
    // 产物为占位版（仍含 [Mermaid 文本段，可继续导出）
    const zip = await JSZip.loadAsync(readFileSync(finalPath))
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).toContain('[Mermaid')
  })
})
