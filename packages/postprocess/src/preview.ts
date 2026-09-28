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
 * 自产"带示意文字"的预览件 —— 两条约束各管各的，互不牵连。
 *
 * ① **帧稳定**（硬约束）：声明尺寸 = 画布 × (LogicalDpi ÷ 参考dpi)。
 *    这里取**统一的** LogicalDpi = 120、参考设备 144dpi（都是验证过的常规值）
 *    ⇒ 声明尺寸 = 画布 × 0.833，两轴同一比例。
 *    反例（踩过两次）：为"铺满"把 LogicalDpi 取成 画面像素 ÷ 画布，扁图/长图上会算出
 *    57 / 599 / 1992 这种非常规 dpi ⇒ Word 认为尺寸需要重算 ⇒ 双击后对象框莫名放大 ✗
 *
 * ② **画面好看**：Word 按画面的**自然尺寸**摆放、超出对象框才裁（06/07 有实测依据），
 *    所以画面自然尺寸要贴近**对象框**而不是贴近画布 ⇒ 模板按"对象框 × 144dpi"挑，
 *    且两轴都不超过它（不裁切）。
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
  // 统一 LogicalDpi；只有"声明尺寸会撞上对象框"时才整体挪 10%（110/120/130 都属常规值）
  let lx = TEMPLATE_LOGICAL_DPI
  let ly = TEMPLATE_LOGICAL_DPI
  const frameWIn = frameWpt !== undefined ? frameWpt / 72 : undefined
  const frameHIn = frameHpt !== undefined ? frameHpt / 72 : undefined
  if (frameWIn !== undefined && Math.abs((wIn * lx) / PREVIEW_REF_DPI / frameWIn - 1) < 0.05) lx = Math.round(lx * 0.9)
  if (frameHIn !== undefined && Math.abs((hIn * ly) / PREVIEW_REF_DPI / frameHIn - 1) < 0.05) ly = Math.round(ly * 0.9)

  const out = new Uint8Array(decodeBase64(t.base64))
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  // 参考设备改写成 144dpi（像素与毫米自洽：1440/254mm、1080/191mm）
  view.setInt32(72, 1440, true)
  view.setInt32(76, 1080, true)
  view.setInt32(80, 254, true)
  view.setInt32(84, 191, true)
  view.setInt32(24, 0, true)
  view.setInt32(28, 0, true)
  view.setInt32(32, Math.round(((wIn * lx) / PREVIEW_REF_DPI) * 2540), true)
  view.setInt32(36, Math.round(((hIn * ly) / PREVIEW_REF_DPI) * 2540), true)
  setLogicalDpi(out, lx, ly)
  return out
}

/** 改写 EMF+ 头注释里的 LogicalDpiX/Y（常规值，两轴同值） */
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
 * 挑模板：目标是"画面自然尺寸 ≈ **对象框**尺寸"（Word 按自然尺寸摆放），
 * 且两轴都不超过 对象框 × 144dpi（保证不被裁）；在这个集合里挑比例最接近画布的一档。
 * 没给对象框时退回按画布挑。
 */
export function pickTemplate(
  canvasWIn: number,
  canvasHIn: number,
  frameWpt?: number,
  frameHpt?: number
): PreviewTemplate {
  const wantAspect = canvasHIn > 0 ? canvasWIn / canvasHIn : 1
  const targetWpx = (frameWpt !== undefined ? frameWpt / 72 : Math.max(canvasWIn, 0.05)) * PREVIEW_REF_DPI
  const targetHpx = (frameHpt !== undefined ? frameHpt / 72 : Math.max(canvasHIn, 0.05)) * PREVIEW_REF_DPI
  const fits = PREVIEW_TEMPLATES.filter((t) => t.pxW <= targetWpx && t.pxH <= targetHpx)
  const pool = fits.length > 0 ? fits : PREVIEW_TEMPLATES
  let best = pool[0]!
  let bestScore = Number.POSITIVE_INFINITY
  for (const t of pool) {
    // 比例差权重高（比例不对占位画面会变成细条或小方块），尺寸差次之（越大越贴近对象框）
    const score =
      3 * Math.abs(Math.log(t.aspect / wantAspect)) +
      Math.abs(Math.log(t.pxW / Math.max(targetWpx, 1))) +
      Math.abs(Math.log(t.pxH / Math.max(targetHpx, 1)))
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
