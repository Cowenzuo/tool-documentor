/** blocks.test.ts — 内容块创建、属性解析与克隆的单测。 */

import { describe, expect, it } from 'vitest'
import {
  BLOCK_LOCK_LEVELS,
  BLOCK_TYPE_NAMES,
  blockFromDb,
  blockTypeIndex,
  blockTypeName,
  cloneBlock,
  createBlock,
  parseBlockLock,
  parseBlockType,
  propsOf,
  type ContentBlock
} from '../src/blocks'

describe('block 类型索引（对齐旧版 BlockType 枚举顺序）', () => {
  it('8 种类型顺序与 0..7 索引一致', () => {
    expect(BLOCK_TYPE_NAMES).toEqual([
      'text',
      'image',
      'table',
      'formula',
      'code',
      'mermaid',
      'orderedList',
      'unorderedList'
    ])
    expect(blockTypeName('0')).toBe('text')
    expect(blockTypeName(7)).toBe('unorderedList')
    expect(blockTypeIndex('mermaid')).toBe(5)
  })

  it('枚举外的类型在写入侧立刻报错，不产出 -1', () => {
    expect(() => createBlock('video' as never)).toThrow(/未知内容块类型/)
    expect(() => blockTypeIndex('video' as never)).toThrow(/未知内容块类型/)
    expect(() => blockTypeName(-1)).toThrow(/未知内容块类型/)
  })

  it('parseBlockType 宽松解析：名字/下标/数字串都认，不认识的返回 null', () => {
    expect(parseBlockType('3')).toBe('formula')
    expect(parseBlockType(4)).toBe('code')
    expect(parseBlockType('mermaid')).toBe('mermaid')
    expect(parseBlockType('-1')).toBeNull()
    expect(parseBlockType('99')).toBeNull()
    expect(parseBlockType('')).toBeNull()
    expect(parseBlockType(1.5)).toBeNull()
  })
})

describe('props 往返（含中文，db props_json 键与旧版一致）', () => {
  it.each<ContentBlock>([
    { type: 'text', content: '中文段落内容，包含换行\n第二行' },
    { type: 'image', imagePath: 'abc-123.png', caption: '系统组成图' },
    {
      type: 'table',
      caption: '表1 示例引用',
      rows: 3,
      cols: 6,
      headers: ['序号', '标识', '标题', '修订版本', '日期', '编写单位/来源'],
      data: [
        ['1', 'DEMO-001', '示例文档', '-', '-', '示例单位'],
        ['2', '-', '示例参考文档', 'V1.0', '-', '示例单位'],
        ['', '', '', '', '', '']
      ]
    },
    { type: 'formula', latexCode: 'E = mc^2' },
    { type: 'code', language: 'cpp', code: 'int main() { return 0; }' },
    { type: 'mermaid', caption: '数据流图', code: 'graph TD\nA-->B' },
    { type: 'orderedList', items: ['软件名称：', '软件标识：', '软件简称：'] },
    { type: 'unorderedList', items: ['需求一', '需求二'] }
  ])('type=$type 经 db 形态往返一致', (block) => {
    const props = propsOf(block)
    const restored = blockFromDb(String(blockTypeIndex(block.type)), props)
    expect(restored).toEqual(block)
    // props 键不包含 type
    expect(Object.keys(props)).not.toContain('type')
  })

  it('createBlock 生成空块（无垃圾键）', () => {
    expect(createBlock('text')).toEqual({ type: 'text', content: '' })
    expect(createBlock('formula')).toEqual({ type: 'formula', latexCode: '' })
    expect(createBlock('table')).toEqual({
      type: 'table',
      caption: '',
      rows: 0,
      cols: 0,
      headers: [],
      data: []
    })
    expect(createBlock('image')).toEqual({ type: 'image', imagePath: '', caption: '' })
    expect(createBlock('code')).toEqual({ type: 'code', language: '', code: '' })
    expect(createBlock('mermaid')).toEqual({ type: 'mermaid', caption: '', code: '' })
    expect(createBlock('orderedList')).toEqual({ type: 'orderedList', items: [] })
  })

  it('cloneBlock 深拷贝且与原块独立', () => {
    const block: ContentBlock = { type: 'table', caption: 'x', rows: 1, cols: 2, headers: ['a'], data: [['1', '2']] }
    const clone = cloneBlock(block)
    expect(clone).toEqual(block)
    expect(clone).not.toBe(block)
    const tableClone = clone as Extract<ContentBlock, { type: 'table' }>
    tableClone.data[0]![1] = 'changed'
    const original = block as Extract<ContentBlock, { type: 'table' }>
    expect(original.data[0]![1]).toBe('2')
  })
})

describe('模板锁 lock（随 props_json 往返，非法值丢弃）', () => {
  it('三档取值经 db 形态往返一致，且落在 props 里', () => {
    for (const lock of BLOCK_LOCK_LEVELS) {
      const block: ContentBlock = { type: 'orderedList', items: ['一', '二'], lock }
      const props = propsOf(block)
      expect(props['lock']).toBe(lock)
      expect(props).not.toHaveProperty('type')
      expect(blockFromDb(String(blockTypeIndex(block.type)), props)).toEqual(block)
    }
  })

  it('各类型都能带 lock，读回不丢', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', content: '正文', lock: 'readonly' },
      { type: 'image', imagePath: 'images/a.png', caption: '图', lock: 'keep' },
      {
        type: 'table',
        caption: '表',
        rows: 1,
        cols: 1,
        headers: ['列'],
        data: [['值']],
        lock: 'type'
      },
      { type: 'formula', latexCode: 'a+b', lock: 'keep' },
      { type: 'code', language: 'cpp', code: 'return 0;', lock: 'readonly' },
      { type: 'mermaid', caption: '图', code: 'graph TD', lock: 'type' },
      { type: 'unorderedList', items: ['项'], lock: 'keep' }
    ]
    for (const block of blocks) {
      expect(blockFromDb(String(blockTypeIndex(block.type)), propsOf(block))).toEqual(block)
    }
  })

  it('老数据没有 lock 时不长出这个键', () => {
    const block: ContentBlock = { type: 'text', content: '老数据' }
    expect(blockFromDb('0', { content: '老数据' })).toEqual(block)
    expect(propsOf(block)).not.toHaveProperty('lock')
    expect(createBlock('text')).not.toHaveProperty('lock')
  })

  it('非法取值一律丢弃，按不锁处理', () => {
    expect(parseBlockLock('keep')).toBe('keep')
    expect(parseBlockLock(' type ')).toBe('type')
    expect(parseBlockLock('readonly')).toBe('readonly')
    expect(parseBlockLock('locked')).toBeUndefined()
    expect(parseBlockLock('')).toBeUndefined()
    expect(parseBlockLock(true)).toBeUndefined()
    expect(parseBlockLock(3)).toBeUndefined()
    expect(parseBlockLock(null)).toBeUndefined()

    const restored = blockFromDb('6', { items: ['一'], lock: '必锁' })
    expect(restored).toEqual({ type: 'orderedList', items: ['一'] })
    expect(restored).not.toHaveProperty('lock')
  })

  it('cloneBlock 保住 lock', () => {
    const block: ContentBlock = { type: 'text', content: '定稿', lock: 'readonly' }
    expect(cloneBlock(block)).toEqual(block)
  })
})
