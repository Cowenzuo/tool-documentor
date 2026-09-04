/**
 * embed.test.ts — OOXML 嵌入端到端（合成骨架 docx + 真实合成 vsdx）。
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { embedVsdxIntoDocx, docxBodyWidthPt } from '../src/embed'
import { parseCompoundFile } from '../src/cfb'

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`

/** 与 DocxWriter 同构的段落（pStyle 数字 ID 风格） */
function para(text: string, styleId = ''): string {
  const pPr = styleId ? `<w:pPr><w:pStyle w:val="${styleId}"/></w:pPr>` : '<w:pPr/>'
  return `<w:p>${pPr}<w:r><w:rPr/><w:t>${text}</w:t></w:r></w:p>`
}

function docXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:v="urn:schemas-microsoft-com:vml">
<w:body>${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1800" w:right="1800" w:bottom="1800" w:left="1800" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>
</w:body></w:document>`
}

async function makeDocx(
  body: string
): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CT)
  zip.file('word/document.xml', docXml(body))
  zip.file('word/_rels/document.xml.rels', RELS)
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' })
}

/** 合成 vsdx：两个 MM 单位形状（bbox 120mm x 75mm）+ 页面尺寸 */
async function makeVsdxBytes(): Promise<Uint8Array> {
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

describe('docxBodyWidthPt', () => {
  it('从 sectPr 推导正文宽', () => {
    expect(docxBodyWidthPt(docXml(''))).toBeCloseTo((11906 - 1800 - 1800) / 20, 4)
  })
})

describe('embedVsdxIntoDocx', () => {
  it('占位段 → w:object（OLE + EMF 预览），rels/CT 闭合，题注保留', async () => {
    const vsdx = await makeVsdxBytes()
    const body =
      para('1 概述', '61') +
      para('[Mermaid 图表: graph TD\\nA-->B]', '45') +
      para('结构图', '60') +
      para('正文文本', '45')
    const docx = await makeDocx(body)
    const result = await embedVsdxIntoDocx(docx, [{
      name: 'sdd-001-结构图.vsdx',
      vsdx,
      preview: new Uint8Array([0x01, 0x02, 0x03]),
      previewExt: 'emf'
    }], { captionStyleId: '60', patchPageSize: true })

    expect(result.embeddedCount).toBe(1)
    expect(result.warnings).toEqual([])
    expect(result.nameMisses).toEqual([])

    const zip = await JSZip.loadAsync(result.docxBytes)
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).not.toContain('[Mermaid')
    expect(doc).toContain('<w:object xmlns:w10="urn:schemas-microsoft-com:office:word">')
    expect(doc).toContain('<o:OLEObject Type="Embed" ProgID="Visio.Drawing.15"')
    expect(doc).toContain('<v:imagedata r:id="rId3" o:title=""/>')
    expect(doc).toContain('r:id="rId2"') // OLE 关系
    expect(doc).toContain('<w:jc w:val="center"/>')
    expect(doc).toContain('结构图') // 图题注段保留

    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
    expect(rels).toContain('relationships/oleObject')
    expect(rels).toContain('Target="embeddings/oleObject1.bin"')
    expect(rels).toContain('Target="media/image1.emf"')

    const ct = await zip.file('[Content_Types].xml')!.async('string')
    expect(ct).toContain('<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>')
    expect(ct).toContain('<Default Extension="emf" ContentType="image/x-emf"/>')

    // 嵌入的 OLE 容器：CFB 解析回读，Package 已是修补页面尺寸后的 vsdx
    const ole = await zip.file('word/embeddings/oleObject1.bin')!.async('uint8array')
    const cfb = parseCompoundFile(ole)
    const pkgZip = await JSZip.loadAsync(cfb['Package']!)
    const pages = await pkgZip.file('visio/pages/pages.xml')!.async('string')
    expect(pages).toMatch(/PageWidth" V="4\.724"/)
    expect(pages).toMatch(/PageHeight" V="2\.953"/)
  })

  it('槽位无 vsdx：保留占位文本，不计数', async () => {
    const body = para('[Mermaid 图表: graph TD\\nA-->B]', '45') + para('结构图', '60')
    const docx = await makeDocx(body)
    const result = await embedVsdxIntoDocx(docx, [{ name: 'sdd-001-结构图.vsdx' }], { captionStyleId: '60' })
    expect(result.embeddedCount).toBe(0)
    const zip = await JSZip.loadAsync(result.docxBytes)
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).toContain('[Mermaid')
  })

  it('多槽位独立：失败槽位不动，成功槽位嵌入', async () => {
    const vsdx = await makeVsdxBytes()
    const body =
      para('[Mermaid 图表: graph TD\\nA-->B]', '45') + para('图一', '60') +
      para('[Mermaid 图表: sequenceDiagram\\nA->>B]', '45') + para('图二', '60')
    const docx = await makeDocx(body)
    const result = await embedVsdxIntoDocx(docx, [
      { name: 'sdd-001-图一.vsdx' }, // 转换失败：跳过
      { name: 'sdd-002-图二.vsdx', vsdx } // 成功
    ], { captionStyleId: '60' })
    expect(result.embeddedCount).toBe(1)
    const zip = await JSZip.loadAsync(result.docxBytes)
    const doc = await zip.file('word/document.xml')!.async('string')
    expect(doc).toContain('[Mermaid 图表: graph TD') // 槽位1保留
    expect(doc.match(/<o:OLEObject/g)!.length).toBe(1)
    expect(doc).toContain('图一')
    expect(doc).toContain('图二')
  })
})
