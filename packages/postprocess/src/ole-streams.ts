/**
 * ole-streams.ts — Visio OLE 嵌入容器的辅助流常量与构造。
 *
 * 合规背景：
 *   旧版 visio_ole.py 从“Word 原生嵌入样本”docx（含甲方文档内容的对照文档）中提取
 *   三个辅助流字节。本实现不再依赖任何样本文件：\x01Ole / \x03ObjInfo 是 MS-CFB /
 *   OLE 公共格式的固定结构字节（公开规范可推导）；\x01CompObj 按 [MS-OLEDS] 的
 *   CompObj 布局程序化构造（版本头 + CLSID + 用户类型 + 应用名 + ProgID,ANSI 串）。
 *   CLSID {00021A15-0000-0000-C000-000000000046} 与 ProgID "Visio.Drawing.15" 是
 *   Microsoft 公开注册的标识符（MS-Visio/注册表公共值），非版权内容。
 */
import { buildCompoundFile } from './cfb'

/** Visio Drawing 15 的公开 CLSID（{00021A15-0000-0000-C000-000000000046} 小端字节） */
export const VISIO_CLSID = new Uint8Array([
  0x15, 0x1a, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46
])

/** ProgID（Word 双击激活时用于定位 server；文档中亦作为 o:OLEObject ProgID 属性） */
export const VISIO_PROGID = 'Visio.Drawing.15'
/** 应用名（CompObj 第二个字符串；旧版样本为 "Visio 15.0 Shapes"） */
export const VISIO_APP_NAME = 'Visio 15.0 Shapes'
/** 用户类型（CompObj 第一个字符串，Word 对象类型显示用；语言中立 ASCII） */
export const VISIO_USER_TYPE = 'Microsoft Visio'

/** \x01Ole 流：20 字节固定结构（OLE 2 协议头，公开格式常量） */
export const OLE01_STREAM = new Uint8Array([
  0x01, 0x00, 0x00, 0x02, 0x08, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00
])

/** \x03ObjInfo 流：6 字节固定结构（公开格式常量） */
export const OBJINFO_STREAM = new Uint8Array([0x00, 0x00, 0x03, 0x00, 0x01, 0x00])

export interface CompObjOptions {
  clsid?: Uint8Array
  userType?: string
  appName?: string
  progId?: string
}

/**
 * 构造 \x01CompObj 流（对齐 Word 原生 Visio 对象的结构字段语义）：
 *   12 字节版本头（01 00 FE FF 03 0A 00 00 FF FF FF FF）
 *   + CLSID(16) + 三个 ANSI 长度前缀串（含终止 NUL 的长度）+ 16 字节保留区（零）。
 */
export function buildCompObj(options: CompObjOptions = {}): Uint8Array {
  const clsid = options.clsid ?? VISIO_CLSID
  const userType = options.userType ?? VISIO_USER_TYPE
  const appName = options.appName ?? VISIO_APP_NAME
  const progId = options.progId ?? VISIO_PROGID
  const head = new Uint8Array([0x01, 0x00, 0xfe, 0xff, 0x03, 0x0a, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff])
  const parts: Uint8Array[] = [head, clsid]
  for (const s of [userType, appName, progId]) {
    const ansi = ascii(s)
    const len = new Uint8Array(4)
    setU32le(len, 0, ansi.length + 1)
    parts.push(len, ansi, new Uint8Array(1)) // 终止 NUL
  }
  parts.push(new Uint8Array(16)) // 保留区（时间戳/占位，Word 激活时重写）
  return concatParts(parts)
}

/**
 * vsdx 字节 → 可被 Word 2013+ “嵌入 OLE 对象”接受的 Compound File 容器字节
 * （结构对齐旧版 make_visio_ole，但辅助流为合成常量而非样本文本流）。
 */
export function makeVisioOle(vsdxBytes: Uint8Array): Uint8Array {
  const streams: Record<string, Uint8Array> = {
    '\x01Ole': OLE01_STREAM,
    'Package': vsdxBytes,
    '\x01CompObj': buildCompObj(),
    '\x03ObjInfo': OBJINFO_STREAM
  }
  return buildCompoundFile(streams, { rootClsid: VISIO_CLSID })
}

// ================= 辅助 =================

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

function setU32le(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff
  out[offset + 1] = (value >> 8) & 0xff
  out[offset + 2] = (value >> 16) & 0xff
  out[offset + 3] = (value >> 24) & 0xff
}

function concatParts(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
