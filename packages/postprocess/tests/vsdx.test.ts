/**
 * vsdx.test.ts — 内容包围盒与页面尺寸修补。
 */
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import { vsdxContentBbox, patchVsdxPageSize } from '../src/vsdx'

async function makeVsdx(vsdxPages: string, pageXml: string): Promise<Uint8Array> {
  const zip = new JSZip()
  zip.file('visio/pages/page1.xml', pageXml)
  zip.file('visio/pages/pages.xml', vsdxPages)
  return zip.generateAsync({ type: 'uint8array' })
}

describe('vsdxContentBbox', () => {
  it('按 Shape 四元组（MM 单位）求包围盒', async () => {
    const page1 = `<?xml version="1.0"?>
<PageContents>
  <Shapes>
    <Shape ID="1"><Cell N="PinX" V="25" U="MM"/><Cell N="PinY" V="30" U="MM"/><Cell N="Width" V="40" U="MM"/><Cell N="Height" V="20" U="MM"/></Shape>
    <Shape ID="2"><Cell N="PinX" V="100" U="MM"/><Cell N="PinY" V="80" U="MM"/><Cell N="Width" V="50" U="MM"/><Cell N="Height" V="30" U="MM"/></Shape>
  </Shapes>
</PageContents>`
    const vsdx = await makeVsdx('<PageSheet/>', page1)
    const bbox = await vsdxContentBbox(vsdx)
    expect(bbox).not.toBeNull()
    expect(bbox!.widthIn).toBeCloseTo(120 / 25.4, 4)
    expect(bbox!.heightIn).toBeCloseTo(75 / 25.4, 4)
  })

  it('无效坐标/无 Shape 返回 null', async () => {
    const vsdx = await makeVsdx('<PageSheet/>', '<PageContents><Shapes/></PageContents>')
    expect(await vsdxContentBbox(vsdx)).toBeNull()
  })
})

describe('patchVsdxPageSize', () => {
  it('修正 PageWidth/PageHeight 并保留 U 单位', async () => {
    const pagesXml =
      '<PageSheet><Cell N="PageWidth" V="210" U="MM"/><Cell N="PageHeight" V="297" U="MM"/></PageSheet>'
    const vsdx = await makeVsdx(pagesXml, '<PageContents><Shapes/></PageContents>')
    const patched = await patchVsdxPageSize(vsdx, 4.7244, 2.9528)
    const zip = await JSZip.loadAsync(patched)
    const text = await zip.file('visio/pages/pages.xml')!.async('string')
    expect(text).toMatch(/<Cell N="PageWidth" V="4\.724" U="MM"\/>/)
    expect(text).toMatch(/<Cell N="PageHeight" V="2\.953" U="MM"\/>/)
  })
})
