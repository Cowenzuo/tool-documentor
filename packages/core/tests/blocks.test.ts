import { describe, expect, it } from 'vitest'
import {
  BLOCK_TYPE_NAMES,
  blockFromDb,
  blockTypeIndex,
  blockTypeName,
  cloneBlock,
  createBlock,
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
