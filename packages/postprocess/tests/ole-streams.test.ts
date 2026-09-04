/**
 * ole-streams.test.ts — 合成辅助流常量与 CompObj 结构（无需任何 Word 样本文件）。
 */
import { describe, it, expect } from 'vitest'
import {
  buildCompObj,
  makeVisioOle,
  VISIO_CLSID,
  VISIO_PROGID,
  VISIO_APP_NAME,
  VISIO_USER_TYPE,
  OLE01_STREAM
} from '../src/ole-streams'
import { parseCompoundFile } from '../src/cfb'

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

describe('buildCompObj', () => {
  it('布局：版本头 + CLSID + 三个 ANSI 长度前缀串（含 NUL）+ 保留区', () => {
    const b = buildCompObj()
    expect([...b.subarray(0, 12)]).toEqual([0x01, 0x00, 0xfe, 0xff, 0x03, 0x0a, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff])
    expect([...b.subarray(12, 28)]).toEqual([...VISIO_CLSID])

    const readStr = (off: number): { text: string; next: number } => {
      const len = b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)
      const bytes = b.subarray(off + 4, off + 4 + len - 1)
      return { text: String.fromCharCode(...bytes), next: off + 4 + len }
    }
    let off = 28
    const user = readStr(off); off = user.next
    const app = readStr(off); off = app.next
    const prog = readStr(off); off = prog.next
    expect(user.text).toBe(VISIO_USER_TYPE)
    expect(app.text).toBe(VISIO_APP_NAME)
    expect(prog.text).toBe(VISIO_PROGID)
    expect(b.length - off).toBe(16) // 保留区
  })
})

describe('makeVisioOle', () => {
  it('产出 CFB：Package 原封不动 + 辅助流就位（可解析回读）', () => {
    const vsdx = new Uint8Array(200000).map((_, i) => (i * 7) & 0xff)
    const ole = makeVisioOle(vsdx)
    const back = parseCompoundFile(ole)
    expect(Buffer.from(back['Package']!).compare(Buffer.from(vsdx))).toBe(0)
    expect([...back['\x01Ole']!]).toEqual([...OLE01_STREAM])
    expect([...back['\x03ObjInfo']!]).toEqual([0x00, 0x00, 0x03, 0x00, 0x01, 0x00])
    // CompObj 含 ProgID 字符串（活动定位依据）
    const comp = Buffer.from(back['\x01CompObj']!).toString('latin1')
    expect(comp.includes(VISIO_PROGID)).toBe(true)
    expect(comp.includes(VISIO_APP_NAME)).toBe(true)
  })

  it('紧凑流（< 4096，走 mini stream）仍可回读', () => {
    const small = ascii('tiny')
    const ole = makeVisioOle(small)
    const back = parseCompoundFile(ole)
    expect(Buffer.from(back['Package']!).toString()).toBe('tiny')
  })
})
