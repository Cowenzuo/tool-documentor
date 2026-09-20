/**
 * cfb.test.ts — CFB 写入/解析往返（对齐旧版 visio_ole.py 自检语义）。
 */
import { describe, it, expect } from 'vitest'
import {
  CFB_DIFAT_ENTRIES,
  CFB_MINI,
  CFB_MINI_CUTOFF,
  buildCompoundFile,
  parseCompoundFile
} from '../src/cfb'
import { OLE01_STREAM, OBJINFO_STREAM, buildCompObj, VISIO_CLSID } from '../src/ole-streams'

const FIXED_NOW = new Date('2024-01-01T00:00:00Z')
/** 扇区链终结值（[MS-CFB] 3.1：ENDOFCHAIN / FREESECT） */
const ENDOFCHAIN = 0xfffffffe
const FREESECT = 0xffffffff

/** 读容器头部 512 字节之外的扇区 */
function sectorView(cfb: Uint8Array, sector: number): DataView {
  const start = 512 + sector * 512
  return new DataView(cfb.buffer, cfb.byteOffset + start, 512)
}

describe('CFB 常量（对外格式契约，不是内部偏好）', () => {
  it('mini 扇区 64 字节、阈值 4096 字节', () => {
    // 这两个数字由 CFB 规范定死，Word 与其它读方按它们解析。
    // 只做读写往返测不出改动（写读用同一常量，自洽），所以单独钉住。
    expect(CFB_MINI).toBe(64)
    expect(CFB_MINI_CUTOFF).toBe(4096)
  })

  it('头部 DIFAT 槽 109 个（偏移 76 起，512 字节头部刚好放满）', () => {
    // 同样由规范定死：写入器不写 DIFAT 链，FAT 扇区数就只能到 109。
    expect(CFB_DIFAT_ENTRIES).toBe(109)
  })
})

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

/** 仿旧版样本流集合（辅助流由合成常量承担，不再依赖样本文档） */
function sampleStreams(packageBytes: Uint8Array): Record<string, Uint8Array> {
  return {
    '\x01Ole': OLE01_STREAM,
    'Package': packageBytes,
    '\x01CompObj': buildCompObj(),
    '\x03ObjInfo': OBJINFO_STREAM
  }
}

describe('buildCompoundFile / parseCompoundFile', () => {
  it('往返一致：辅助流 + 大 Package 流（对齐旧版自检2）', () => {
    const pkg = new Uint8Array(22551).map((_, i) => i & 0xff)
    const streams = sampleStreams(pkg)
    const cfb = buildCompoundFile(streams, { rootClsid: VISIO_CLSID, now: FIXED_NOW })
    const back = parseCompoundFile(cfb)
    expect(Object.keys(back).length).toBe(Object.keys(streams).length)
    for (const k of Object.keys(streams)) {
      expect(Buffer.from(back[k]!).compare(Buffer.from(streams[k]!))).toBe(0)
    }
  })

  it('mini 流边界：4095 / 4096 / 4097 字节', () => {
    const mk = (n: number) => new Uint8Array(n).fill(0xab)
    const streams: Record<string, Uint8Array> = {
      'Small4095': mk(4095),
      'Boundary4096': mk(4096),
      'Big4097': mk(4097),
      'Tiny3': mk(3),
      'Empty': new Uint8Array(0),
      '\x01Ole': OLE01_STREAM
    }
    const cfb = buildCompoundFile(streams, { now: FIXED_NOW })
    const back = parseCompoundFile(cfb)
    for (const k of Object.keys(streams)) {
      expect(back[k]!.length).toBe(streams[k]!.length)
    }
    // 中文/特殊名也在目录树中（msNameKey 顺序）
    const streamsCN: Record<string, Uint8Array> = {
      '图1 结构': ascii('a'),
      '图2 数据流': new Uint8Array(16).fill(1),
      'Package': new Uint8Array(5000).fill(2)
    }
    const cfb2 = buildCompoundFile(streamsCN, { now: FIXED_NOW })
    const back2 = parseCompoundFile(cfb2)
    expect(Object.keys(back2).sort()).toEqual(['Package', '图1 结构', '图2 数据流'])
  })

  it('根 CLSID 写入可被解析（OLE 激活定位用）', () => {
    const cfb = buildCompoundFile({ 'Testing': ascii('x') }, {
      rootClsid: VISIO_CLSID,
      now: FIXED_NOW
    })
    // Root Entry 位于第一个目录扇区首条目；CLSID @ offset 80..96
    const view = new DataView(cfb.buffer, cfb.byteOffset, cfb.byteLength)
    const firstDirSector = view.getUint32(48, true)
    const base = 512 + firstDirSector * 512
    const clsid = [...cfb.subarray(base + 80, base + 96)]
    expect(clsid).toEqual([...VISIO_CLSID])
  })
})

describe('未使用槽一律写 FREESECT（FAT 与 miniFAT 同口径）', () => {
  it('miniFAT 的未分配槽不是 0', () => {
    // 两个小流各占 2 个 mini 扇区 → 4 个已用槽 + 1 个 miniFAT 扇区里余下的 124 个未使用槽。
    // 写 0 会被读方当成“链到 mini 扇区 0”（0 是合法扇区号），与 FAT 的 FREESECT 口径不一致。
    const cfb = buildCompoundFile(
      { A: new Uint8Array(100).fill(1), B: new Uint8Array(70).fill(2) },
      { now: FIXED_NOW }
    )
    const head = new DataView(cfb.buffer, cfb.byteOffset, cfb.byteLength)
    expect(head.getUint32(64, true)).toBe(1) // 一个 miniFAT 扇区
    const miniFat = sectorView(cfb, head.getUint32(60, true))
    const slots: number[] = []
    for (let i = 0; i < 128; i++) slots.push(miniFat.getUint32(i * 4, true))
    // 已用槽按分配顺序串链：A(100B→2 扇区: 0→1)、B(70B→2 扇区: 2→3)
    expect(slots.slice(0, 4)).toEqual([1, ENDOFCHAIN, 3, ENDOFCHAIN])
    expect(slots.slice(4)).toEqual(new Array(124).fill(FREESECT))
  })

  it('FAT 的未使用槽同样是 FREESECT（对照，不是本次改动）', () => {
    const cfb = buildCompoundFile(
      { A: new Uint8Array(100).fill(1), B: new Uint8Array(70).fill(2) },
      { now: FIXED_NOW }
    )
    const head = new DataView(cfb.buffer, cfb.byteOffset, cfb.byteLength)
    const nFat = head.getUint32(44, true)
    const fat = sectorView(cfb, 0)
    const slots: number[] = []
    for (let i = 0; i < 128; i++) slots.push(fat.getUint32(i * 4, true))
    // 0=FAT 自身，1=目录，2=miniFAT 链，3=根 mini stream：4 个已用槽，其余 FREESECT
    expect(nFat).toBe(1)
    expect(slots.slice(0, 4)).toEqual([0xfffffffd, ENDOFCHAIN, ENDOFCHAIN, ENDOFCHAIN])
    expect(slots.slice(4)).toEqual(new Array(124).fill(FREESECT))
  })
})

describe('DIFAT 上限（本写入器不写 DIFAT 链）', () => {
  /** 一个占 nSectors 个整扇区的常规流（≥4096 字节，不占 miniFAT） */
  const bigStream = (nSectors: number): Uint8Array => new Uint8Array(nSectors * 512)

  it('FAT 扇区数正好 109：头部 109 槽放得下，容器可回读', () => {
    // 需要 109 个 FAT 扇区：127k ≥ 数据扇区 + k + 目录扇区 的临界点（127×109 = 13843）
    const payload = bigStream(13842)
    const cfb = buildCompoundFile({ Package: payload }, { now: FIXED_NOW })
    const head = new DataView(cfb.buffer, cfb.byteOffset, cfb.byteLength)
    expect(head.getUint32(44, true)).toBe(CFB_DIFAT_ENTRIES) // num FAT sectors
    expect(head.getUint32(68, true)).toBe(ENDOFCHAIN) // first DIFAT sector：不写链
    // 第 109 个槽（偏移 76 + 108×4）登记最后一个 FAT 扇区号，没有被漏掉
    expect(head.getUint32(76 + 108 * 4, true)).toBe(108)
    expect(parseCompoundFile(cfb)['Package']!.length).toBe(payload.length)
  })

  it('FAT 扇区数 110：抛可读错误，不产出坏容器', () => {
    // 数据扇区 13843 时（多一个扇区）需要 110 个 FAT 扇区，第 110 个在 512 字节头部已无处登记
    let message = ''
    try {
      buildCompoundFile({ Package: bigStream(13843) }, { now: FIXED_NOW })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toMatch(/嵌入对象过大/)
    expect(message).toContain('110 个 FAT 扇区')
    expect(message).toContain(`DIFAT 槽上限 ${CFB_DIFAT_ENTRIES}`)
  })
})
