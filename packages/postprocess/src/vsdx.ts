/**
 * vsdx.ts — VSDX 内容包围盒与页面尺寸修补。
 *
 * 移植自《documentor 旧版 scripts/embed_vsdx.py》：
 *   - 从 visio/pages/page1.xml 的 Shape 坐标求内容包围盒；
 *   - 把 visio/pages/pages.xml 的 PageWidth/PageHeight 修正为包围盒尺寸，
 *     避免 Word 按默认 Letter 画布放大对象（双击激活后的画布与显示尺寸一致）。
 */
import JSZip from 'jszip'

const UNIT_TO_INCH: Record<string, number> = {
  IN: 1.0,
  MM: 1.0 / 25.4,
  CM: 1.0 / 2.54,
  PT: 1.0 / 72.0
}

/** 属性值：单双引号都要认 */
const ATTR = (name: string): string => `${name}=["']([^"']*)["']`

/**
 * 取一段 XML 里所有 `<Cell …>` 的 N/V/U（引号风格与属性顺序都不敏感）。
 *
 * 为什么必须容错：mmd2vsdx 自己写的 page XML 用**单引号**、属性顺序也不固定；
 * Visio 另存过的则是双引号。曾经只认 `N="…" V="…"` 这一种写法，
 * 于是新版 mmd2vsdx 的产物整份读不出来，画布尺寸静默退化成兜底值。
 */
function parseCells(xml: string): Array<{ tag: string; n: string; v: string; u: string }> {
  const out: Array<{ tag: string; n: string; v: string; u: string }> = []
  const tagRe = /<Cell\b[^>]*\/?>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(xml)) !== null) {
    const tag = m[0]
    const n = new RegExp(ATTR('N')).exec(tag)?.[1]
    const v = new RegExp(ATTR('V')).exec(tag)?.[1]
    const u = new RegExp(ATTR('U')).exec(tag)?.[1]
    if (n === undefined || v === undefined) continue
    out.push({ tag, n, v, u: u ?? 'IN' })
  }
  return out
}

/** 把某个 `<Cell N=…>` 的 V 改掉（保留其它属性），并统一成双引号 */
function setCellValue(xml: string, cellName: string, valueIn: number): string {
  const tagRe = /<Cell\b[^>]*\/?>/g
  return xml.replace(tagRe, (tag) => {
    const n = new RegExp(ATTR('N')).exec(tag)?.[1]
    if (n !== cellName) return tag
    return tag
      .replace(new RegExp(ATTR('V')), `V="${valueIn}"`)
      .replace(/(\b[A-Za-z]+)=['"]/g, '$1="')
      .replace(/['"](?=[\s/>])/g, '"')
  })
}

export interface VsdxBbox {
  /** 内容包围盒宽（英寸） */
  widthIn: number
  /** 内容包围盒高（英寸） */
  heightIn: number
}

/**
 * 从页 XML 的 Shapes 坐标求内容包围盒（英寸）；无法求值时返回 null。
 * 需要 page1.xml 存在且至少两个有效 Shape（含 PinX/PinY/Width/Height 四元组，
 * 单位 U 可换算为英寸）。
 */
export async function vsdxContentBbox(vsdxData: Uint8Array | ArrayBuffer): Promise<VsdxBbox | null> {
  let pageXml: string
  try {
    const zip = await JSZip.loadAsync(vsdxData)
    const page = zip.file('visio/pages/page1.xml')
    if (!page) return null
    pageXml = await page.async('string')
  } catch {
    return null
  }

  const xs: number[] = []
  const ys: number[] = []
  const shapeRe = /<Shape\b[\s\S]*?<\/Shape>/g
  let m: RegExpExecArray | null
  while ((m = shapeRe.exec(pageXml)) !== null) {
    const shape = m[0]
    const cells = new Map<string, [number, string]>()
    // U 可以缺省：缺省表示按页面默认单位（mmd2vsdx 写出来的多数格就没有 U，那批是英寸）。
    // **缺省不等于这个形状不算数** —— 曾经要求 U 必须存在，于是把整批缺省形状漏掉，
    // 包围盒只剩带 MM 的那几个小形状，页面被压到 3mm，图在文档里成了 8.5pt 的小点。
    for (const c of parseCells(shape)) {
      if (c.n === 'PinX' || c.n === 'PinY' || c.n === 'Width' || c.n === 'Height') {
        cells.set(c.n, [parseFloat(c.v), c.u])
      }
    }
    if (!cells.has('PinX') || !cells.has('PinY') || !cells.has('Width') || !cells.has('Height')) continue
    const [cx, cxU] = cells.get('PinX')!
    const [cy, cyU] = cells.get('PinY')!
    const [w, wU] = cells.get('Width')!
    const [h, hU] = cells.get('Height')!
    const toIn = (v: number, unit: string): number => {
      const k = UNIT_TO_INCH[unit.toUpperCase()]
      return k !== undefined ? v * k : 0
    }
    const cxI = toIn(cx, cxU)
    const cyI = toIn(cy, cyU)
    const wI = toIn(w, wU)
    const hI = toIn(h, hU)
    if (wI <= 0 || hI <= 0) continue
    xs.push(cxI - wI / 2, cxI + wI / 2)
    ys.push(cyI - hI / 2, cyI + hI / 2)
  }
  if (xs.length >= 2 && ys.length >= 2) {
    const wIn = Math.max(...xs) - Math.min(...xs)
    const hIn = Math.max(...ys) - Math.min(...ys)
    if (wIn > 0.01) return { widthIn: wIn, heightIn: Math.max(hIn, 0.01) }
  }
  return null
}

/**
 * 把 visio/pages/pages.xml 的 PageSheet 页面尺寸修补为内容包围盒（英寸）。
 * **按格子自己的单位换算了再写**：格子可能写 MM/CM/PT（U 属性），
 * 早先直接把英寸数写进去，`U="MM"` 的页面就被缩成 1/25.4（实测把 A4 页写成 4.7mm）。
 * 返回重新打包（DEFLATE）后的 vsdx 字节。
 */
export async function patchVsdxPageSize(
  vsdxData: Uint8Array | ArrayBuffer,
  widthIn: number,
  heightIn: number
): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(vsdxData)
  const pageEntry = zip.file('visio/pages/pages.xml')
  if (!pageEntry) return new Uint8Array(vsdxData instanceof ArrayBuffer ? new Uint8Array(vsdxData) : vsdxData)
  let text = await pageEntry.async('string')

  const fix = (cellName: string, inches: number): void => {
    // 引号风格与属性顺序都不敏感；改写时统一成双引号，便于后续读取。
    const cell = parseCells(text).find((c) => c.n === cellName)
    if (!cell) return
    const perUnit = UNIT_TO_INCH[cell.u.toUpperCase()] ?? 1
    text = setCellValue(text, cellName, Number((inches / perUnit).toFixed(3)))
  }
  fix('PageWidth', widthIn)
  fix('PageHeight', heightIn)

  zip.file('visio/pages/pages.xml', text)
  const buf = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS'
  })
  return buf
}

/**
 * 剥掉 vsdx 里的 `docProps/thumbnail.emf`（连同它的关系与内容类型声明）。
 *
 * 为什么：那是"文件预览缩略图"，与 Word 里对象的呈现图无关，且它是"Visio 保存过的图纸"里没有的多余件
 * （见 docs/WORD处理经验/06 的部件对照）。留着无害也无益，剥掉让内嵌件更接近 Visio 的稳定形态。
 * 没有该部件时原样返回（不重新打包）。
 */
export async function stripVsdxThumbnail(vsdxData: Uint8Array | ArrayBuffer): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(vsdxData)
  const thumb = Object.keys(zip.files).find((n) => /^docProps\/thumbnail\.(emf|png|jpg|jpeg|wmf)$/i.test(n))
  if (!thumb) return new Uint8Array(vsdxData instanceof ArrayBuffer ? new Uint8Array(vsdxData) : vsdxData)
  zip.remove(thumb)

  const relsEntry = zip.file('_rels/.rels')
  if (relsEntry) {
    const rels = await relsEntry.async('string')
    zip.file('_rels/.rels', rels.replace(/<Relationship [^>]*thumbnail[^>]*\/>/gi, ''))
  }
  const ctEntry = zip.file('[Content_Types].xml')
  if (ctEntry) {
    const stillEmf = Object.keys(zip.files).some((n) => !zip.files[n]!.dir && /\.emf$/i.test(n))
    const ct = await ctEntry.async('string')
    const ext = /\.(\w+)$/.exec(thumb)?.[1]?.toLowerCase() ?? ''
    const stillSameExt = Object.keys(zip.files).some((n) => !zip.files[n]!.dir && n.toLowerCase().endsWith(`.${ext}`))
    if (ext === 'emf' && !stillEmf) zip.file('[Content_Types].xml', ct.replace(/<Default Extension="emf"[^>]*\/>/gi, ''))
    else if (!stillSameExt && ext) zip.file('[Content_Types].xml', ct.replace(new RegExp(`<Default Extension="${ext}"[^>]*/>`, 'gi'), ''))
  }

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    platform: 'DOS'
  })
}

/**
 * 读 visio/pages/pages.xml 的页面尺寸（英寸）；读不到返回 null。
 *
 * **对象框的基准尺寸就是它**：页面 = 这张图的画布，72pt/in，乘出来就是图的自然尺寸。
 * 不能用内容包围盒（那是形状范围，不含页边，也不是画布）。
 */
export async function vsdxPageSize(
  vsdxData: Uint8Array | ArrayBuffer
): Promise<VsdxBbox | null> {
  let pagesXml: string
  try {
    const zip = await JSZip.loadAsync(vsdxData)
    const pages = zip.file('visio/pages/pages.xml')
    if (!pages) return null
    pagesXml = await pages.async('string')
  } catch {
    return null
  }
  const cell = (name: string): number | null => {
    const found = parseCells(pagesXml).find((c) => c.n === name)
    if (!found) return null
    const k = UNIT_TO_INCH[found.u.toUpperCase()]
    return k !== undefined ? parseFloat(found.v) * k : null
  }
  const widthIn = cell('PageWidth')
  const heightIn = cell('PageHeight')
  if (widthIn === null || heightIn === null || widthIn <= 0 || heightIn <= 0) return null
  return { widthIn, heightIn }
}

/** 从 vsdx 字节读取 page1.xml（测试辅助） */
export async function readVsdxPage1(vsdxData: Uint8Array | ArrayBuffer): Promise<string | null> {
  try {
    const zip = await JSZip.loadAsync(vsdxData)
    const page = zip.file('visio/pages/page1.xml')
    return page ? await page.async('string') : null
  } catch {
    return null
  }
}
