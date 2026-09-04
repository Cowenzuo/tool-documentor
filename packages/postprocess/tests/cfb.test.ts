/**
 * cfb.test.ts — CFB 写入/解析往返（对齐旧版 visio_ole.py 自检语义）。
 */
import { describe, it, expect } from 'vitest'
import { buildCompoundFile, parseCompoundFile } from '../src/cfb'
import { OLE01_STREAM, OBJINFO_STREAM, buildCompObj, VISIO_CLSID } from '../src/ole-streams'

const FIXED_NOW = new Date('2024-01-01T00:00:00Z')

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
