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
 *      因此模板里的 dpi 组刻意取比值 120/96 = 1.25 ≠ 1。
 */
import { PREVIEW_TEMPLATES } from './preview-template'
import type { PreviewTemplate } from './preview-template'

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

/** 运行时使用的参考设备 dpi（D 组实验验证过 96/144 都安全，这里统一用 144） */
export const PREVIEW_REF_DPI = 144

/**
 * 自产"带示意文字"的预览件 —— 布局按公式算，不做试凑。
 *
 * 目标（两条硬约束同时成立）：
 *   ① 画面完整不被裁 + 铺满对象框 ⇒ **画面自然尺寸 = 声明尺寸**；
 *   ② 帧不移动 ⇒ **声明尺寸 = 画布 × (LogicalDpi ÷ 参考dpi)**（自洽式）。
 *
 * 取 ref = 144dpi、L = 画面像素 ÷ 画布in，则：
 *   声明 = 画布 × L ÷ 144 = 画面像素 ÷ 144 = 画面自然尺寸   ⇒ ① 成立（按构造相等）
 *   且声明 = 画布 × L ÷ ref 本身就是自洽式                  ⇒ ② 成立
 * 两个 dpi 都落在已验证的常规区间（ref 144 属 D2 组，L 实测 90~122 与基准组 120 同档），
 * 不走"按对象把 dpi 改到 64 以下"那条会把对象框撑大的路。
 */
export function makePreviewEmf(
  canvasWIn: number,
  canvasHIn: number,
  frameWpt?: number,
  frameHpt?: number
): Uint8Array {
  const t = pickTemplate(canvasWIn, canvasHIn, frameWpt, frameHpt)
  const wIn = Math.max(canvasWIn, 0.05)
  const hIn = Math.max(canvasHIn, 0.05)
  const out = new Uint8Array(decodeBase64(t.base64))
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  // 参考设备改成 144dpi（像素与毫米自洽：1440/254mm、1080/190.5mm）
  view.setInt32(72, 1440, true)
  view.setInt32(76, 1080, true)
  view.setInt32(80, 254, true)
  view.setInt32(84, 191, true)
  // 分轴 LogicalDpi：使 声明尺寸 = 画面自然尺寸
  const lx = Math.max(1, Math.round(t.pxW / wIn))
  const ly = Math.max(1, Math.round(t.pxH / hIn))
  view.setInt32(24, 0, true)
  view.setInt32(28, 0, true)
  view.setInt32(32, Math.round(((wIn * lx) / PREVIEW_REF_DPI) * 2540), true)
  view.setInt32(36, Math.round(((hIn * ly) / PREVIEW_REF_DPI) * 2540), true)
  setLogicalDpi(out, lx, ly)
  return out
}

/** 改写 EMF+ 头注释里的 LogicalDpiX/Y（分轴，常规值） */
function setLogicalDpi(emf: Uint8Array, lx: number, ly: number): void {
  const view = new DataView(emf.buffer, emf.byteOffset, emf.byteLength)
  let off = view.getUint32(4, true)
  while (off + 8 <= emf.length) {
    const type = view.getUint32(off, true)
    const size = view.getUint32(off + 4, true)
    if (size < 8 || off + size > emf.length) break
    if (type === 70 && view.getUint16(off + 16, true) === 0x4001) {
      view.setUint32(off + 36, lx, true)
      view.setUint32(off + 40, ly, true)
      return
    }
    if (type === 14) break
    off += size
  }
}

/**
 * 挑模板：比例最接近画布比例、且**模板自然尺寸最接近 画布 × 1.25**。
 *
 * 为什么目标是 画布 × 1.25：这样 LogicalDpi = 画面像素 ÷ 画布 ≈ 120，与基准组（L=120、ref=96）
 * 同一档；配合运行时把参考设备设成 144，声明尺寸恰好等于画面自然尺寸（铺满且不裁），
 * 且两个 dpi 都落在 D 组验证过的常规区间内。
 */
export function pickTemplate(
  canvasWIn: number,
  canvasHIn: number,
  frameWpt?: number,
  frameHpt?: number
): PreviewTemplate {
  const ratio = TEMPLATE_LOGICAL_DPI / TEMPLATE_REF_DPI // 1.25
  const wantAspect = canvasHIn > 0 ? canvasWIn / canvasHIn : 1
  const targetW = Math.max(canvasWIn, 0.05) * ratio
  const frameWIn = frameWpt !== undefined ? frameWpt / 72 : undefined
  const frameHIn = frameHpt !== undefined ? frameHpt / 72 : undefined
  let best = PREVIEW_TEMPLATES[0]!
  let bestScore = Number.POSITIVE_INFINITY
  for (const t of PREVIEW_TEMPLATES) {
    // 比例差权重高（比例不对画面变形），尺寸差次之
    let score = 3 * Math.abs(Math.log(t.aspect / wantAspect)) + Math.abs(Math.log(t.naturalWIn / targetW))
    // 护栏：声明尺寸 = 画面自然尺寸（= px ÷ 144）。若它落在对象框的 ±5% 内，
    // 就与"声明 = 框"那种会撑大的情形太接近 ⇒ 重罚，换一档（相邻档差 ≈19%，能自然躲开）。
    const declW = t.pxW / PREVIEW_REF_DPI
    const declH = t.pxH / PREVIEW_REF_DPI
    if (frameWIn !== undefined && Math.abs(declW / frameWIn - 1) < 0.05) score += 10
    if (frameHIn !== undefined && Math.abs(declH / frameHIn - 1) < 0.05) score += 10
    if (score < bestScore) {
      bestScore = score
      best = t
    }
  }
  return best
}

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
