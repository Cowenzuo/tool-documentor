/**
 * preview.ts — 自产 / 校正 OLE 对象的预览图（EMF+ 双格式）。
 *
 * 为什么这么做，见 docs/WORD处理经验/06（口径）与 07（方案）。要点：
 *
 *   1. Word 更新对象时会换掉预览图，并在那次替换里按下面这条重算对象框：
 *        新框 = 旧框 × (替换图声明 ÷ 存图声明) × (本机物理dpi ÷ 存图参考dpi) × (存图LogicalDpi ÷ 本机逻辑dpi)
 *      而替换图（Visio 现渲的那张）的声明尺寸是：`画布 × (本机逻辑dpi ÷ 本机物理dpi)`；
 *   2. 代进去 ⇒ 只要 **声明尺寸 = 画布 × (LogicalDpi ÷ 参考设备dpi)** 成立，本机 dpi 全部相消，框不变；
 *   3. 额外护栏：**声明尺寸不得等于对象框尺寸**（实测相等必被撑大）。
 *
 * 画面本身**按对象算，不用模板**（2026-09-28 改）：比例与尺寸必须贴合对象框，
 * 靠"预生成档位"只能近似（2 倍步长最坏铺满 0.59 ✗），而这里几何是确定的：
 *   画面像素 = 对象框in × 参考dpi、字号 = 画面短边 × 5.5%、内缩 = 短边 × 12% …
 * 记录按 GDI+ 自己产出的文件逐字段对齐（rcl 用空矩形、串不加 NUL、offDx = 76 + 2n），
 * 否则 GDI+ 解析会直接报 "A generic error occurred in GDI+"。
 */

/** 模板自带的 dpi 组：参考设备 96dpi、LogicalDpi 120 ⇒ 比值 1.25 */
export const TEMPLATE_REF_DPI = 96
export const TEMPLATE_LOGICAL_DPI = 120

const EMFF_SIGNATURE = 0x464d4520
const HEADER_MIN_SIZE = 88

export interface PreviewMetrics {
  /** 头记录长度（88 或 108） */
  headerSize: number
  declaredWIn: number
  declaredHIn: number
  /** 参考设备 dpi（横轴）= szlDevice宽 ÷ szlMillimeters宽 × 25.4 */
  refDpi: number
  /** 参考设备 dpi（纵轴） */
  refDpiY: number
  /** EMF+ 头注释里的 LogicalDpiX */
  logicalDpi: number | null
  /** EMF+ 头注释里的 LogicalDpiY */
  logicalDpiY: number | null
  nBytes: number
  nRecords: number
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** 自带 base64 解码：不依赖 Buffer/atob，主进程与渲染进程都能用 */
function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let acc = 0
  let bits = 0
  let p = 0
  for (const ch of clean) {
    const v = B64.indexOf(ch)
    if (v < 0) continue
    acc = (acc << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[p++] = (acc >> bits) & 0xff
    }
  }
  return out.subarray(0, p)
}

function readU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function readI32(view: DataView, offset: number): number {
  return view.getInt32(offset, true)
}

/** 读 EMF 头与第 1 条 EMF+ 头注释里的尺寸字段；不是 EMF 则返回 null */
export function readPreviewMetrics(emf: Uint8Array): PreviewMetrics | null {
  if (emf.length < HEADER_MIN_SIZE) return null
  const view = new DataView(emf.buffer, emf.byteOffset, emf.byteLength)
  if (readU32(view, 0) !== 1) return null
  const headerSize = readU32(view, 4)
  if (headerSize < HEADER_MIN_SIZE || headerSize > emf.length) return null
  if (readU32(view, 40) !== EMFF_SIGNATURE) return null

  const mmW = readI32(view, 80)
  const mmH = readI32(view, 84)
  const refDpi = mmW > 0 && mmH > 0 ? readI32(view, 72) / (mmW / 25.4) : 0
  const refDpiY = mmW > 0 && mmH > 0 ? readI32(view, 76) / (mmH / 25.4) : 0

  // 走记录，找第 1 条 EMF+ 头注释（type=70，载荷含 'EMF+'，内部 type=0x4001）
  let logicalDpi: number | null = null
  let logicalDpiY: number | null = null
  let off = headerSize
  while (off + 8 <= emf.length) {
    const type = readU32(view, off)
    const size = readU32(view, off + 4)
    if (size < 8 || off + size > emf.length) break
    if (type === 70 && readU32(view, off + 8) >= 0x20 && view.getUint16(off + 16, true) === 0x4001) {
      logicalDpi = readU32(view, off + 36)
      logicalDpiY = readU32(view, off + 40)
    }
    if (type === 14) break
    off += size
  }

  return {
    headerSize,
    declaredWIn: (readI32(view, 32) - readI32(view, 24)) / 2540,
    declaredHIn: (readI32(view, 36) - readI32(view, 28)) / 2540,
    refDpi,
    refDpiY,
    logicalDpi,
    logicalDpiY,
    nBytes: readU32(view, 48),
    nRecords: readU32(view, 52)
  }
}

/** 自洽式要求的声明尺寸（**分轴**：画布 × 逻辑dpi ÷ 参考dpi） */
export function expectedDeclaredIn(
  metrics: PreviewMetrics,
  canvasWIn: number,
  canvasHIn: number
): { w: number; h: number } | null {
  const lx = metrics.logicalDpi
  const ly = metrics.logicalDpiY ?? metrics.logicalDpi
  if (!lx || !ly || metrics.refDpi <= 0 || metrics.refDpiY <= 0) return null
  return { w: (canvasWIn * lx) / metrics.refDpi, h: (canvasHIn * ly) / metrics.refDpiY }
}

/** 自洽校验：声明尺寸是否≈画布 × 逻辑dpi ÷ 参考dpi（默认容差 2%） */
export function checkPreviewConsistency(
  emf: Uint8Array,
  canvasWIn: number,
  canvasHIn: number,
  tolerance = 0.02
): { ok: boolean; metrics: PreviewMetrics; expected: { w: number; h: number } | null } | null {
  const metrics = readPreviewMetrics(emf)
  if (!metrics) return null
  const expected = expectedDeclaredIn(metrics, canvasWIn, canvasHIn)
  if (!expected || expected.w <= 0 || expected.h <= 0) return { ok: false, metrics, expected }
  const okW = Math.abs(metrics.declaredWIn - expected.w) / expected.w <= tolerance
  const okH = Math.abs(metrics.declaredHIn - expected.h) / expected.h <= tolerance
  return { ok: okW && okH, metrics, expected }
}

/**
 * 校正外部预览件：只把 `rclFrame`（声明尺寸）改成自洽值，其余字节一律不动。
 * 画面、记录、dpi 字段全部保留 —— 改的只有"这张图声明自己多大"。
 */
export function normalizePreviewEmf(emf: Uint8Array, canvasWIn: number, canvasHIn: number): Uint8Array | null {
  const metrics = readPreviewMetrics(emf)
  if (!metrics) return null
  const expected = expectedDeclaredIn(metrics, canvasWIn, canvasHIn)
  if (!expected) return null
  const out = new Uint8Array(emf)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const left = readI32(view, 24)
  const top = readI32(view, 28)
  view.setInt32(24, left, true)
  view.setInt32(28, top, true)
  view.setInt32(32, left + Math.round(expected.w * 2540), true)
  view.setInt32(36, top + Math.round(expected.h * 2540), true)
  return out
}

export { PREVIEW_REF_DPI, PREVIEW_LOGICAL_DPI, makePreviewEmf, previewGeometry } from './preview-emf'

export function declaredEqualsFrame(
  emf: Uint8Array,
  frameWidthPt: number,
  frameHeightPt: number,
  tolerancePt = 1
): boolean {
  const metrics = readPreviewMetrics(emf)
  if (!metrics) return false
  const dw = metrics.declaredWIn * 72
  const dh = metrics.declaredHIn * 72
  return Math.abs(dw - frameWidthPt) <= tolerancePt || Math.abs(dh - frameHeightPt) <= tolerancePt
}

/** dpi 允许区间：参考设备与逻辑 dpi 都必须落在里面，且两轴之差不超过 10% */
export const PREVIEW_DPI_MIN = 96
export const PREVIEW_DPI_MAX = 160

/**
 * 护栏：dpi 是否越出常规区间（越界 ⇒ Word 会认为尺寸需要重算 ⇒ 双击后对象框被改）。
 *
 * 为什么要有这条：曾经（2026-09）为了满足"画面自然尺寸 = 声明尺寸"，把 LogicalDpi 当成自由变量取
 * `画面像素 ÷ 画布in`，扁图上算出 57 / 600 / 1992 这种值 —— 自洽式仍然成立、本地自检全绿，
 * 只有人双击后才发现框被放大 ✗。**dpi 不是可调量，它是格式的常规字段**，所以在这里硬卡住。
 */
export function previewDpiOutOfBand(emf: Uint8Array): { ref: number; lx: number; ly: number } | null {
  const m = readPreviewMetrics(emf)
  if (!m || m.logicalDpi === null || m.logicalDpiY === null) return null
  const band = (v: number): boolean => v >= PREVIEW_DPI_MIN && v <= PREVIEW_DPI_MAX
  const skew = Math.abs(m.logicalDpi - m.logicalDpiY) / Math.max(m.logicalDpi, 1) > 0.1
  if (band(m.refDpi) && band(m.refDpiY) && band(m.logicalDpi) && band(m.logicalDpiY) && !skew) return null
  return { ref: m.refDpi, lx: m.logicalDpi, ly: m.logicalDpiY }
}
