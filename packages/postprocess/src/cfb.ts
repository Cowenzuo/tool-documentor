/**
 * cfb.ts — Compound File Binary (CFB / OLE2 容器) 写入与解析。
 *
 * 直接移植自已验证的《documentor 旧版 scripts/visio_ole.py》（_build_cf / _cf_parse）。
 * MS-CFB 是公开格式规范（[MS-CFB]），本实现不依赖任何第三方 CFB 库，也不依赖任何
 * 承载版权内容的“Word 原生样本”文件 —— 辅助流字节由 ole-streams.ts 按公开结构常量合成。
 *
 * 关键规则（与旧版一致）：
 *   - 目录树必须按 Microsoft 比较规则排序（名称长度优先，同长按 UTF-16 码元序），
 *     否则 StgOpenStorage 查找流时走错分支，OLE 激活失败；
 *   - < 4096 字节的流走 mini stream（64 字节 mini 扇区），miniFAT 按分配顺序串链；
 *   - FAT 扇区数需同时覆盖 数据扇区 + miniFAT 扇区 + FAT 自身 + 目录扇区；
 *   - 未使用槽（FAT 与 miniFAT）一律写 FREESECT，不写 0 —— 0 是合法扇区号；
 *   - 目录条目用“中位递归”构造平衡 BST（与旧版同构），未使用条目保持 0xFF；
 *   - 本写入器不写 DIFAT 链，FAT 扇区数上限即头部的 109 个 DIFAT 槽，超出直接报错。
 */
export const CFB_SECTOR = 512
export const CFB_MINI = 64
export const CFB_MINI_CUTOFF = 4096
/**
 * CFB 头部（偏移 76..511）的 DIFAT 槽数。109 × 128 项/扇区 × 512 字节 ≈ 7.1 MB：
 * 再大就需要 DIFAT 链，而本写入器不写链，只能失败（见 buildCompoundFile 的守卫）。
 */
export const CFB_DIFAT_ENTRIES = 109
const FREESECT = 0xffffffff
const ENDOFCHAIN = 0xfffffffe
const FATSECT = 0xfffffffd
const DIFSECT = 0xfffffffc

const CFB_SIGNATURE = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

export interface CfbBuildOptions {
  /** Root Entry 的 CLSID（激活时用于定位 OLE server） */
  rootClsid?: Uint8Array
  /** 根条目名称（默认 "Root Entry"） */
  rootName?: string
  /** 时间戳源（默认当前时间；测试可注入） */
  now?: Date
}

/** 读小端 u32（无越界检查，样式与旧版一致） */
function rdU32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

/** 把 Uint8Array 打包为 CFB 字节 */
export function buildCompoundFile(
  streams: Record<string, Uint8Array>,
  options: CfbBuildOptions = {}
): Uint8Array {
  const rootClsid = options.rootClsid ?? new Uint8Array(16)
  const rootName = options.rootName ?? 'Root Entry'
  const names = Object.keys(streams).sort(compareMsName)
  const miniCutoff = CFB_MINI_CUTOFF
  const sectorSize = CFB_SECTOR
  const miniSize = CFB_MINI

  // ---- mini stream：< 4096 的流按 64 字节对齐拼接 ----
  const miniParts: Uint8Array[] = []
  for (const n of names) {
    const len = streams[n]!.length
    if (len < miniCutoff) {
      const pad = (miniSize - (len % miniSize)) % miniSize
      miniParts.push(streams[n]!)
      if (pad > 0) miniParts.push(new Uint8Array(pad))
    }
  }
  const miniStream = concat(miniParts)

  // ---- 常规流 + 根 mini stream 的扇区布局 ----
  const bigPayloads: Array<[string, Uint8Array]> = []
  for (const n of names) {
    if (streams[n]!.length >= miniCutoff) bigPayloads.push([n, streams[n]!])
  }
  if (miniStream.length > 0) bigPayloads.push(['__mini__', miniStream])
  const totalRegular = bigPayloads.reduce((sum, [, p]) => sum + alignUp(p.length, sectorSize) / sectorSize, 0)

  // ---- 目录条目数：root + 流数 ----
  const nDirEntries = 1 + names.length
  const dirSectors = Math.max(1, alignUp(nDirEntries * 128, sectorSize) / sectorSize)

  // ---- miniFAT：每个 mini 扇区 4 字节；mini 流按分配顺序串链 ----
  let miniFat: number[] = []
  let miniCur = 0
  for (const n of names) {
    const len = streams[n]!.length
    if (len < miniCutoff && len > 0) {
      const nSec = alignUp(len, miniSize) / miniSize
      for (let j = 0; j < nSec; j++) {
        miniFat.push(j < nSec - 1 ? miniCur + j + 1 : ENDOFCHAIN)
      }
      miniCur += nSec
    }
  }
  const nMini = miniFat.length
  const miniFatSectors = nMini > 0 ? alignUp(miniFat.length * 4, sectorSize) / sectorSize : 0

  // ---- FAT 扇区数：需覆盖 数据扇区 + miniFAT 扇区 + FAT 自身 + 目录 ----
  const fatNeed = (nDataSectors: number): number => {
    for (let k = 1; k < 4096; k++) {
      if (k * (sectorSize / 4) >= nDataSectors + miniFatSectors + k + dirSectors) return k
    }
    throw new Error('图表文件解析失败：扇区数过多')
  }
  const nFat = fatNeed(totalRegular)
  // 头部只有 CFB_DIFAT_ENTRIES 个 DIFAT 槽，且本写入器把 first DIFAT 写成 ENDOFCHAIN（不写链）：
  // 超出的 FAT 扇区在头部无处登记，读方按 numFat 找过去会拿到空槽，只能读到被截断的流。
  // 与其静默产出非法容器，不如在这里失败（约 7 MB 的嵌入对象是这条路的上限）。
  if (nFat > CFB_DIFAT_ENTRIES) {
    throw new Error(
      `嵌入对象过大：需要 ${nFat} 个 FAT 扇区，超过 CFB 头部 DIFAT 槽上限 ${CFB_DIFAT_ENTRIES} 个` +
      '（约 7 MB 的嵌入对象）；当前写入器不生成 DIFAT 链，无法写入该对象'
    )
  }
  const totalSecs = totalRegular + miniFatSectors + nFat + dirSectors

  // ---- 扇区布局：0..nFat-1=FAT；nFat..=目录；其后数据（miniFAT 链 + 数据流） ----
  const dirStart = nFat
  const dataStart = nFat + dirSectors

  const fat: number[] = new Array(nFat * (sectorSize / 4)).fill(FREESECT)
  for (let i = 0; i < nFat; i++) fat[i] = FATSECT

  // 目录扇区链
  for (let i = 0; i < dirSectors - 1; i++) fat[dirStart + i] = dirStart + i + 1
  if (dirSectors > 0) fat[dirStart + dirSectors - 1] = ENDOFCHAIN

  let allocUsed = 0
  const allocChain = (count: number): number => {
    const start = dataStart + allocUsed
    for (let i = 0; i < count - 1; i++) fat[start + i] = start + i + 1
    fat[start + count - 1] = ENDOFCHAIN
    allocUsed += count
    return start
  }

  // miniFAT 扇区 + 常规流链
  const miniFatChainStart = nMini > 0 ? allocChain(miniFatSectors) : ENDOFCHAIN
  const streamChains = new Map<string, number>()
  for (const [n, p] of bigPayloads) {
    streamChains.set(n, allocChain(alignUp(p.length, sectorSize) / sectorSize))
  }

  // ---- 目录条目构建：root DID 0，流 DID 1..N ----
  const didOf = new Map<string, number>()
  names.forEach((n, idx) => didOf.set(n, 1 + idx))

  const mkEntry = (name: string, type: number, start: number, size: number, opts: {
    child?: number, left?: number, right?: number, clsid?: Uint8Array, mtime?: Uint8Array
  }): Uint8Array => {
    const e = new Uint8Array(128)
    const rawUtf16: number[] = []
    for (const ch of name) rawUtf16.push(ch.charCodeAt(0))
    const raw16 = new Uint8Array(rawUtf16.length * 2)
    rawUtf16.forEach((c, i) => {
      raw16[i * 2] = c & 0xff
      raw16[i * 2 + 1] = (c >> 8) & 0xff
    })
    e.set(raw16.subarray(0, 126))
    setU16(e, 64, raw16.length + 2) // name_len incl. terminator
    e[66] = type
    e[67] = 1 // black
    setU32(e, 68, opts.left ?? 0xffffffff)
    setU32(e, 72, opts.right ?? 0xffffffff)
    setU32(e, 76, opts.child ?? 0xffffffff)
    e.set((opts.clsid ?? new Uint8Array(16)).subarray(0, 16), 80)
    if (opts.mtime) e.set(opts.mtime.subarray(0, 8), 108)
    setU32(e, 116, start)
    setU32(e, 120, size & 0xffffffff)
    setU32(e, 124, Math.floor(size / 0x100000000))
    return e
  }

  // 用名字构造平衡 BST（取中位递归）
  const entries = new Map<number, Uint8Array>()
  const buildBst = (idxList: number[]): number => {
    if (idxList.length === 0) return 0xffffffff
    const mid = Math.floor(idxList.length / 2)
    const nameIdx = idxList[mid]!
    const n = names[nameIdx]!
    const left = buildBst(idxList.slice(0, mid))
    const right = buildBst(idxList.slice(mid + 1))
    const size = streams[n]!.length
    let start = 0
    if (size >= miniCutoff) {
      start = streamChains.get(n) ?? 0
    } else if (size > 0) {
      // mini 流：mini 扇区号 = 前面所有 mini 流（64 对齐）字节偏移 / 64
      let off = 0
      for (let x = 0; x < nameIdx; x++) {
        if (streams[names[x]!]!.length < miniCutoff) {
          off += alignUp(streams[names[x]!]!.length, miniSize)
        }
      }
      start = off / miniSize
    }
    entries.set(didOf.get(n)!, mkEntry(n, 2, start, size, { left, right }))
    return didOf.get(n)!
  }
  const rootChild = buildBst(names.map((_, i) => i))
  const rootStart = miniStream.length > 0 ? streamChains.get('__mini__')! : ENDOFCHAIN
  entries.set(0, mkEntry(rootName, 5, rootStart, miniStream.length, {
    child: rootChild,
    clsid: rootClsid,
    mtime: nowFileTime(options.now)
  }))

  // 未使用条目保持 0xFF（对齐 Word 生成行为）
  const dirData = new Uint8Array(dirSectors * sectorSize).fill(0xff)
  for (const [did, e] of entries) dirData.set(e, did * 128)

  // ---- 组装 ----
  const out = new Uint8Array(512 + totalSecs * sectorSize)
  out.set(CFB_SIGNATURE, 0)
  setU16(out, 24, 0x003e) // minor
  setU16(out, 26, 0x0003) // major
  setU16(out, 28, 0xfffe) // byte order
  setU16(out, 30, 9) // sector shift (512)
  setU16(out, 32, 6) // mini shift (64)
  setU32(out, 40, 0) // reserved
  setU32(out, 44, nFat) // num FAT sectors
  setU32(out, 48, dirStart) // first directory sector
  setU32(out, 52, 0)
  setU32(out, 56, miniCutoff)
  setU32(out, 60, nMini > 0 ? miniFatChainStart : ENDOFCHAIN) // first miniFAT sector
  setU32(out, 64, miniFatSectors) // num miniFAT sectors
  setU32(out, 68, ENDOFCHAIN) // first DIFAT = none
  setU32(out, 72, 0)
  const difat = new Array<number>(109).fill(FREESECT)
  for (let i = 0; i < nFat; i++) difat[i] = i
  for (let i = 0; i < 109; i++) setU32(out, 76 + i * 4, difat[i] ?? FREESECT)

  const putSector = (s: number, chunk: Uint8Array): void => {
    const padded = chunk.length < sectorSize ? concat([chunk, new Uint8Array(sectorSize - chunk.length)]) : chunk
    out.set(padded, 512 + s * sectorSize)
  }

  // FAT 扇区
  for (let i = 0; i < nFat; i++) {
    const chunk = fat.slice(i * (sectorSize / 4), (i + 1) * (sectorSize / 4))
    const sec = new Uint8Array(sectorSize)
    chunk.forEach((v, j) => setU32(sec, j * 4, v))
    putSector(i, sec)
  }
  // 目录
  for (let i = 0; i < dirSectors; i++) {
    putSector(dirStart + i, dirData.subarray(i * sectorSize, (i + 1) * sectorSize))
  }
  // miniFAT 表：每 mini 扇区 4 字节
  if (nMini > 0) {
    // 整扇区先填 FREESECT（0xFFFFFFFF，小端即 4 个 0xFF）：未使用槽写 0 会被读方当成
    // “链到 mini 扇区 0”，与 FAT 的未使用槽口径不一致；末尾补到整扇区的那部分同样要填。
    const mf = new Uint8Array(miniFatSectors * sectorSize).fill(0xff)
    miniFat.forEach((v, i) => setU32(mf, i * 4, v))
    for (let i = 0; i < miniFatSectors; i++) {
      putSector(miniFatChainStart + i, mf.subarray(i * sectorSize, (i + 1) * sectorSize))
    }
  }
  // 数据流
  for (const [n, p] of bigPayloads) {
    const start = streamChains.get(n)!
    const nSec = alignUp(p.length, sectorSize) / sectorSize
    for (let i = 0; i < nSec; i++) {
      const chunk = p.subarray(i * sectorSize, (i + 1) * sectorSize)
      putSector(start + i, chunk)
    }
  }
  return out
}

/** 解析 CFB，返回 {stream_name: bytes}（仅存储流，type==2） */
export function parseCompoundFile(data: Uint8Array): Record<string, Uint8Array> {
  if (data.length < 512 || !equalBytes(data.subarray(0, 8), CFB_SIGNATURE)) {
    throw new Error('图表文件非 Compound File 格式')
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const sectorShift = rdU16(view, 30)
  const miniShift = rdU16(view, 32)
  const numFat = rdU32(view, 44)
  const firstDir = rdU32(view, 48)
  const miniCutoff = rdU32(view, 56)
  const firstMiniFat = rdU32(view, 60)
  const numMiniFat = rdU32(view, 64)
  const sectorSize = 1 << sectorShift
  const miniSize = 1 << miniShift

  const difat0 = new Array<number>(109).fill(0)
  for (let i = 0; i < 109; i++) difat0[i] = rdU32(view, 76 + i * 4)
  const fatSectors = difat0.slice(0, numFat).filter((s) => s !== FREESECT)
  // DIFAT 链（本实现从不写 DIFAT，保守支持）
  const firstDifAt = rdU32(view, 68)
  let cur = firstDifAt
  while (cur !== ENDOFCHAIN && cur !== FREESECT && fatSectors.length < numFat) {
    const sec = sector(view, data, cur, sectorSize)
    const vals = u32Array(sec)
    for (let i = 0; i < vals.length - 1 && fatSectors.length < numFat; i++) {
      const v = vals[i]!
      if (v !== FREESECT) fatSectors.push(v)
    }
    cur = vals[vals.length - 1]!
  }

  const chain = (start: number): number[] => {
    const out: number[] = []
    let s = start
    let guard = 0
    while (s !== ENDOFCHAIN && s !== FREESECT && guard < 100000) {
      out.push(s)
      const fs = fatSectors[Math.floor(s / (sectorSize / 4))]!
      if (fs === undefined) break
      const fatSec = sector(view, data, fs, sectorSize)
      s = rdU32From(fatSec, (s % (sectorSize / 4)) * 4)
      guard++
    }
    return out
  }

  const readChain = (sectors: number[], size: number): Uint8Array => {
    const parts = sectors.map((s) => sector(view, data, s, sectorSize))
    return concat(parts).subarray(0, size)
  }

  const dirSectorsList = chain(firstDir)
  const dirData = readChain(dirSectorsList, dirSectorsList.length * sectorSize)
  const entries: Array<{ name: string; type: number; start: number; size: number }> = []
  for (let i = 0; i < dirData.length; i += 128) {
    const nameLen = rdU16From(dirData, i + 64)
    if (nameLen === 0) continue
    const name = utf16le(dirData.subarray(i, i + nameLen - 2))
    const type = dirData[i + 66]!
    const start = rdU32From(dirData, i + 116)
    const size = rdU32From(dirData, i + 120) + rdU32From(dirData, i + 124) * 0x100000000
    entries.push({ name, type, start, size })
  }

  const root = entries.find((e) => e.type === 5)
  if (!root) throw new Error('图表文件解析失败：缺少 Root Entry')
  const miniFatParts: Uint8Array[] = []
  for (const s of chain(firstMiniFat)) {
    if (s >= fatSectors.length * (sectorSize / 4)) break
    miniFatParts.push(sector(view, data, s, sectorSize))
  }
  const miniFat = concat(miniFatParts)
  const rootData = readChain(chain(root.start), root.size)

  const readStream = (start: number, size: number): Uint8Array => {
    if (size === 0) return new Uint8Array(0)
    if (size < miniCutoff) {
      const parts: Uint8Array[] = []
      let s = start
      let guard = 0
      while (s !== ENDOFCHAIN && guard < 1000000) {
        parts.push(rootData.subarray(s * miniSize, (s + 1) * miniSize))
        s = rdU32From(miniFat, s * 4)
        guard++
      }
      return concat(parts).subarray(0, size)
    }
    return readChain(chain(start), size)
  }

  const result: Record<string, Uint8Array> = {}
  for (const e of entries) {
    if (e.type === 2) result[e.name] = readStream(e.start, e.size)
  }
  return result
}

// ================= 辅助 =================

/** MS-CFB 目录树排序键：名字长度优先，同长按 UTF-16 码元序 */
function compareMsName(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

function alignUp(value: number, unit: number): number {
  return Math.ceil(value / unit) * unit
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

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function sector(view: DataView, data: Uint8Array, s: number, sectorSize: number): Uint8Array {
  const start = 512 + s * sectorSize
  return data.subarray(start, Math.min(start + sectorSize, data.length))
}

function u32Array(data: Uint8Array): number[] {
  const out: number[] = []
  for (let i = 0; i + 4 <= data.length; i += 4) {
    out.push(rdU32From(data, i))
  }
  return out
}

function rdU16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function rdU16From(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8)
}

function rdU32From(data: Uint8Array, offset: number): number {
  return (data[offset]! |
    (data[offset + 1]! << 8) |
    (data[offset + 2]! << 16) |
    (data[offset + 3]! << 24)) >>> 0
}

function setU16(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff
  out[offset + 1] = (value >> 8) & 0xff
}

function setU32(out: Uint8Array, offset: number, value: number): void {
  out[offset] = value & 0xff
  out[offset + 1] = (value >> 8) & 0xff
  out[offset + 2] = (value >> 16) & 0xff
  out[offset + 3] = (value >> 24) & 0xff
}

function utf16le(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    text += String.fromCharCode(bytes[i]! | (bytes[i + 1]! << 8))
  }
  return text
}

/** 当前时间转 Windows FILETIME（100ns 间隔，自 1601-01-01），小端 8 字节 */
export function nowFileTime(now: Date = new Date()): Uint8Array {
  const EPOCHE_MS = Date.UTC(1601, 0, 1)
  const ft = Math.floor((now.getTime() - EPOCHE_MS) * 10000)
  const out = new Uint8Array(8)
  setU32(out, 0, ft & 0xffffffff)
  setU32(out, 4, Math.floor(ft / 0x100000000))
  return out
}
