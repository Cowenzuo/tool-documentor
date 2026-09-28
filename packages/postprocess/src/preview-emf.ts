/**
 * preview-emf.ts — 按对象**算**出预览画面并手写 EMF 字节（不用预生成模板）。
 *
 * 为什么不用模板档位：变量表要求"画面比例 = 对象框比例（±0.5%）、画面自然尺寸 = 对象框尺寸（0.95~1.00）"，
 * 而档位是有限集合（2 倍步长最坏只铺满 0.59、比例也对不上）⇒ 只能按对象算。
 *
 * 几何（全部由对象框短边与参考dpi 推出，没有可调档位）：
 *   画面像素 = 对象框in × 参考dpi（两轴同尺度 ⇒ 画面比例 = 框比例）
 *   内缩     = 短边 × 12%（≥ 线宽，保证边框墨迹在画面内）
 *   线宽     = max(1, 短边 × 0.8%)
 *   字号     = 短边 × 5.5%，再按"整行 ≤ 内框宽 × 0.9"收窄（不设固定下限）
 *   文字     = 单行，居中（中心 = 画面中心）
 *   墨迹     = 边框外接 ∪ 文字外接，写进 rclBounds，保证 ⊂ [0,0,画面像素]
 *
 * 记录字段照 GDI+ 自己产出的文件对齐（见 docs/WORD处理经验/07 的死路记录）：
 *   EMR_EXTTEXTOUTW 的 rcl 用空矩形 [0,0,-1,-1]、字符串不加 NUL、offDx = 76 + 2n、Dx 数组必须给。
 */

/** 运行时统一使用的参考设备 dpi（D 组实验验证过 96/144 都安全） */
export const PREVIEW_REF_DPI = 144
/** 统一 LogicalDpi（基准组取值；两轴同值，绝不分轴） */
export const PREVIEW_LOGICAL_DPI = 120

const COLOR_WHITE = 0x00ffffff
const COLOR_BORDER = 0x00bebebe
const COLOR_TEXT = 0x006e6e6e
const EMFF_SIGNATURE = 0x464d4520
const HEADER_SIZE = 88

/** 一行提示（单行：GDI+ 解析多条 EXTTEXTOUTW 记录会失败，见 07 的死路记录） */
const TEXT = 'mmd2vsdx 生成 · 双击用 Visio 查看'

export interface PreviewGeometry {
  /** 画面像素 */
  pxW: number
  pxH: number
  /** 边框内缩（px） */
  margin: number
  /** 线宽（px） */
  pen: number
  /** 字号（px） */
  font: number
  /** 文字外接宽（px，估算） */
  textW: number
  /** 墨迹外接（px） */
  ink: { left: number; top: number; right: number; bottom: number }
}

/**
 * 字符步进宽度（em 倍数）—— **实测值**，不是估的。
 *
 * 为什么必须实测：EMR_EXTTEXTOUTW 的 Dx 数组是消费端排版依据；写小了英文就叠字
 * （曾按 0.55em 估，而 Microsoft YaHei 的 'm' 实际 1.25em ⇒ "mmd2vsdx" 挤成一团 ✗，
 * 汉字因为估的是 1.0em 反而看着正常）。
 *
 * 量法：System.Drawing.MeasureString + 差值法（W(base+c) − W(base)，消掉内边距），
 * 字体 'Microsoft YaHei'，见 temp/工具/测步进2.ps1。未列出的字符取"宁可宽一点"的默认值，
 * 多留一点字距看不出，叠字很难看。
 */
const ADVANCE_EM: Record<string, number> = {
  m: 1.2493,
  d: 0.8629,
  '2': 0.7819,
  v: 0.6999,
  s: 0.6172,
  x: 0.6758,
  V: 0.9017,
  i: 0.3548,
  o: 0.8477,
  ' ': 0.3945,
  '·': 0.321,
  '0': 0.7819,
  '1': 0.7819,
  '3': 0.7819,
  '4': 0.7819,
  '5': 0.7819,
  '6': 0.7819,
  '7': 0.7819,
  '8': 0.7819,
  '9': 0.7819
}
/** 汉字与全角标点：实测 1.3333em（不是 1.0） */
const ADVANCE_CJK = 1.3333
/** 其它拉丁/符号的保守默认（宁可宽一点） */
const ADVANCE_DEFAULT = 0.9

/** 取一个字符的步进（em） */
function advanceEm(ch: string): number {
  const c = ch.codePointAt(0)!
  if (c < 0x2e80) return ADVANCE_EM[ch] ?? ADVANCE_DEFAULT
  return ADVANCE_CJK
}

/** 估一行宽度：按实测步进表求和 */
function estimateWidth(text: string, fontPx: number): number {
  let w = 0
  for (const ch of text) w += advanceEm(ch) * fontPx
  return w
}

/** 由画布 + 对象框 + 逻辑dpi 算出全部几何（导出便于自测断言） */
export function previewGeometry(
  canvasWIn: number,
  canvasHIn: number,
  frameWIn: number,
  frameHIn: number,
  logicalDpi = PREVIEW_LOGICAL_DPI
): PreviewGeometry {
  // ① 画面像素 = 画布in × 逻辑dpi ⇒ 画面物理尺寸 = 画布 × L ÷ 参考dpi = **声明尺寸**（两者必须相等，
  //    否则消费端把声明矩形映射到对象框时，内容只会占一角或溢出 ⇒ 没铺满/偏角/只有一部分）
  const pxW = Math.max(8, Math.min(20000, Math.round(canvasWIn * logicalDpi)))
  const pxH = Math.max(8, Math.min(20000, Math.round(canvasHIn * logicalDpi)))
  // ② 视觉尺寸（在对象框上的观感）折算到画面像素：声明矩形里 1in = 参考dpi px
  const visual = (inches: number): number => Math.max(1, Math.round(inches * PREVIEW_REF_DPI))
  const frameShortIn = Math.min(frameWIn, frameHIn)
  const pen = Math.max(1, visual(frameShortIn * 0.008))
  const margin = Math.max(pen + 1, visual(frameShortIn * 0.12))
  const innerW = pxW - 2 * margin
  let font = Math.max(1, visual(frameShortIn * 0.055))
  // 整行不超内框（GDI+ 实际渲染比估算宽，留 1.35 倍余量）；不设固定下限，小画面就小字号
  while (font > 1 && estimateWidth(TEXT, font) * 1.35 > innerW * 0.9) font -= 1
  const textW = estimateWidth(TEXT, font)
  const textH = Math.round(font * 1.2)
  const halfTextW = Math.ceil(textW / 2)
  const halfTextH = Math.ceil(textH / 2)
  const cx = Math.round(pxW / 2)
  const cy = Math.round(pxH / 2)
  const ink = {
    left: Math.max(0, Math.min(margin - Math.ceil(pen / 2), cx - halfTextW)),
    top: Math.max(0, Math.min(margin - Math.ceil(pen / 2), cy - halfTextH)),
    right: Math.min(pxW - 1, Math.max(pxW - margin + Math.ceil(pen / 2), cx + halfTextW)),
    bottom: Math.min(pxH - 1, Math.max(pxH - margin + Math.ceil(pen / 2), cy + halfTextH))
  }
  return { pxW, pxH, margin, pen, font, textW, ink }
}

/**
 * 自产预览件：按对象框算画面 + 自洽声明尺寸。
 * 声明尺寸 = 画布 × (LogicalDpi ÷ 参考dpi)；撞上对象框时整体挪 10%（仍属常规值）。
 */
export function makePreviewEmf(
  canvasWIn: number,
  canvasHIn: number,
  frameWpt?: number,
  frameHpt?: number
): Uint8Array {
  const wIn = Math.max(canvasWIn, 0.05)
  const hIn = Math.max(canvasHIn, 0.05)
  // 没给对象框时按画布估（调用方总会给；兜底保持可运行）
  const frameWIn = frameWpt !== undefined ? Math.max(frameWpt / 72, 0.02) : wIn * 0.833
  const frameHIn = frameHpt !== undefined ? Math.max(frameHpt / 72, 0.02) : hIn * 0.833

  let lx = PREVIEW_LOGICAL_DPI
  let ly = PREVIEW_LOGICAL_DPI
  if (Math.abs((wIn * lx) / PREVIEW_REF_DPI / frameWIn - 1) < 0.05) lx = Math.round(lx * 0.9)
  if (Math.abs((hIn * ly) / PREVIEW_REF_DPI / frameHIn - 1) < 0.05) ly = Math.round(ly * 0.9)
  const declaredW = (wIn * lx) / PREVIEW_REF_DPI
  const declaredH = (hIn * ly) / PREVIEW_REF_DPI
  const g = previewGeometry(wIn, hIn, frameWIn, frameHIn, Math.min(lx, ly))

  const records: Uint8Array[] = []
  records.push(plusHeaderComment(lx, ly))
  // 白画刷(0) → 灰笔(1) → 边框
  records.push(record(39, 24, (v) => {
    v.setUint32(8, 0, true)
    v.setUint32(12, 0, true)
    v.setUint32(16, COLOR_WHITE, true)
    v.setUint32(20, 0, true)
  }))
  records.push(record(38, 28, (v) => {
    v.setUint32(8, 1, true)
    v.setUint32(12, 0, true)
    v.setInt32(16, g.pen, true)
    v.setInt32(20, 0, true)
    v.setUint32(24, COLOR_BORDER, true)
  }))
  records.push(record(37, 12, (v) => v.setUint32(8, 0, true)))
  records.push(record(37, 12, (v) => v.setUint32(8, 1, true)))
  records.push(record(43, 24, (v) => {
    v.setInt32(8, g.margin, true)
    v.setInt32(12, g.margin, true)
    v.setInt32(16, g.pxW - g.margin - 1, true)
    v.setInt32(20, g.pxH - g.margin - 1, true)
  }))
  // 字体(2) → 透明底 + 灰字 + 居中基线
  records.push(record(82, 104, (v) => {
    v.setUint32(8, 2, true)
    v.setInt32(12, -g.font, true)
    v.setInt32(16, 0, true)
    v.setInt32(20, 0, true)
    v.setInt32(24, 0, true)
    v.setInt32(28, 400, true)
    v.setUint8(32, 0)
    v.setUint8(33, 0)
    v.setUint8(34, 0)
    v.setUint8(35, 1)
    v.setUint8(36, 0)
    v.setUint8(37, 0)
    v.setUint8(38, 4)
    v.setUint8(39, 0)
    const face = 'Microsoft YaHei'
    for (let i = 0; i < face.length; i += 1) v.setUint16(40 + i * 2, face.charCodeAt(i), true)
  }))
  records.push(record(37, 12, (v) => v.setUint32(8, 2, true)))
  records.push(record(18, 12, (v) => v.setUint32(8, 1, true)))
  records.push(record(24, 12, (v) => v.setUint32(8, COLOR_TEXT, true)))
  records.push(record(22, 12, (v) => v.setUint32(8, 6 | 24, true)))
  records.push(textRecord(TEXT, Math.round(g.pxW / 2), Math.round(g.pxH / 2 + g.font * 0.35), g))
  records.push(record(40, 12, (v) => v.setUint32(8, 0, true)))
  records.push(record(40, 12, (v) => v.setUint32(8, 1, true)))
  records.push(record(40, 12, (v) => v.setUint32(8, 2, true)))

  const body = concat(records)
  const header = new Uint8Array(HEADER_SIZE)
  const hv = new DataView(header.buffer)
  hv.setUint32(0, 1, true)
  hv.setUint32(4, HEADER_SIZE, true)
  hv.setInt32(8, g.ink.left, true)
  hv.setInt32(12, g.ink.top, true)
  hv.setInt32(16, g.ink.right, true)
  hv.setInt32(20, g.ink.bottom, true)
  hv.setInt32(24, 0, true)
  hv.setInt32(28, 0, true)
  hv.setInt32(32, Math.round(declaredW * 2540), true)
  hv.setInt32(36, Math.round(declaredH * 2540), true)
  hv.setUint32(40, EMFF_SIGNATURE, true)
  hv.setUint32(44, 0x00010000, true)
  hv.setUint32(48, HEADER_SIZE + body.length, true)
  hv.setUint32(52, records.length + 1, true)
  hv.setUint16(56, 3, true)
  hv.setUint16(58, 0, true)
  hv.setUint32(60, 0, true)
  hv.setUint32(64, 0, true)
  hv.setUint32(68, 0, true)
  hv.setInt32(72, 1440, true) // 参考设备：1440x1440px / 254x254mm（= 10in，两轴都严格 144.00dpi）
  hv.setInt32(76, 1440, true)
  hv.setInt32(80, 254, true)
  hv.setInt32(84, 254, true)
  return concat([header, body])
}

/** EMF+ 头注释（44 字节，LogicalDpi 两轴同值） */
function plusHeaderComment(lx: number, ly: number): Uint8Array {
  const out = new Uint8Array(44)
  const v = new DataView(out.buffer)
  v.setUint32(0, 70, true)
  v.setUint32(4, 44, true)
  v.setUint32(8, 32, true)
  out.set([0x45, 0x4d, 0x46, 0x2b], 12)
  v.setUint16(16, 0x4001, true)
  v.setUint16(18, 1, true)
  v.setUint32(20, 28, true)
  v.setUint32(24, 16, true)
  v.setUint32(28, 0, true)
  v.setUint32(32, 0, true)
  v.setUint32(36, lx, true)
  v.setUint32(40, ly, true)
  return out
}

function record(type: number, size: number, fill: (v: DataView) => void): Uint8Array {
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  v.setUint32(0, type, true)
  v.setUint32(4, size, true)
  fill(v)
  return out
}

/** EMR_EXTTEXTOUTW（字段照 GDI+ 自己的产出对齐） */
function textRecord(text: string, x: number, y: number, g: PreviewGeometry): Uint8Array {
  const n = text.length
  const size = 76 + n * 2 + n * 4
  const out = new Uint8Array(size)
  const v = new DataView(out.buffer)
  v.setUint32(0, 84, true)
  v.setUint32(4, size, true)
  v.setInt32(8, 0, true)
  v.setInt32(12, 0, true)
  v.setInt32(16, g.pxW - 1, true)
  v.setInt32(20, g.pxH - 1, true)
  v.setUint32(24, 1, true)
  v.setFloat32(28, 1, true)
  v.setFloat32(32, 1, true)
  v.setInt32(36, x, true)
  v.setInt32(40, y, true)
  v.setUint32(44, n, true)
  v.setUint32(48, 76, true)
  v.setUint32(52, 0, true)
  v.setInt32(56, 0, true) // rcl：空矩形，不裁切
  v.setInt32(60, 0, true)
  v.setInt32(64, -1, true)
  v.setInt32(68, -1, true)
  v.setUint32(72, 76 + n * 2, true)
  for (let i = 0; i < n; i += 1) {
    const ch = text[i]!
    v.setUint16(76 + i * 2, text.charCodeAt(i), true)
    // 步进按实测表给（再留 2% 余量）：写小了英文会叠字
    v.setInt32(76 + n * 2 + i * 4, Math.round(advanceEm(ch) * g.font * 1.02), true)
  }
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
