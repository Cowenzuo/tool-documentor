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
    const cellRe = /<Cell N="(PinX|PinY|Width|Height)" V="([\d.eE+-]+)" U="(\w+)"/g
    let cm: RegExpExecArray | null
    while ((cm = cellRe.exec(shape)) !== null) {
      cells.set(cm[1]!, [parseFloat(cm[2]!), cm[3]!])
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
 * 只替换 PageSheet 内的首个该 Cell 值并保留原 U 单位（mmd2vsdx 写 IN）。
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

  const fix = (cellName: string, value: number): void => {
    const re = new RegExp(`(<Cell N="${cellName}" V=")[\\d.eE+-]*(")`)
    text = text.replace(re, (_all, head: string, tail: string) => head + value.toFixed(3) + tail)
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
