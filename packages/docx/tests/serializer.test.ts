import { describe, expect, it } from 'vitest'
import { resetIdCounterForTest } from '@documentor/core/idgen'
import { DocumentNode, DocumentTree } from '@documentor/core/tree'
import { serializeToInstructions } from '../src/serializer'
import type { StyleTemplateDef } from '@documentor/templates'
import type { WriteInstruction } from '../src/instructions'

const styleDef: StyleTemplateDef = {
  name: '测试样式',
  version: '1',
  description: '',
  fileKey: 'test',
  docxFolder: 'x',
  basePath: '',
  styleMap: {
    'heading.1': '49',
    'heading.2': '50',
    'heading.3': '52',
    'subtitle.1': '65',
    'subtitle.2': '67',
    body: '45',
    'table.caption': '48',
    'table.header': '88',
    'table.body': '95',
    'figure.caption': '60',
    'list.unordered.1': '62',
    'list.ordered.1': '65'
  },
  skeletonPath: ''
}

function node(headingLevel: number, title: string): DocumentNode {
  const n = new DocumentNode(headingLevel)
  n.title = title
  return n
}

describe('DocxSerializer 指令序列', () => {
  it('章节标题 → heading 样式段落（根不输出标题）', () => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    root.title = '文档根'
    root.addChild(node(1, '范围'))
    root.children[0]!.addChild(node(2, '标识'))
    const tree = new DocumentTree(root)
    const instructions = serializeToInstructions(tree, styleDef)
    expect(instructions.map((i) => (i.opType === 'InsertParagraph' ? i.styleName : 'TABLE'))).toEqual([
      '49', // 范围
      '50' // 标识
    ])
  })

  it('SubTitle → subtitle.<depth> 样式', () => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    const chapter = node(1, '第1章')
    const sub = node(2, '概述')
    sub.isSubTitle = true
    chapter.addChild(sub)
    const sub2 = node(3, '二级子')
    sub2.isSubTitle = true
    sub.addChild(sub2)
    root.addChild(chapter)
    const instructions = serializeToInstructions(new DocumentTree(root), styleDef)
    const styles = instructions.map((i) =>
      i.opType === 'InsertParagraph' ? i.styleName : ''
    )
    expect(styles).toEqual(['49', '65', '67'])
  })

  it('内容块：文本/列表独立组/表格题注剥离/图题注后置', () => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    const section = node(2, '标识')
    section.contentBlocks.push(
      { type: 'text', content: '一段正文' },
      { type: 'orderedList', items: ['甲', '', '乙'] },
      { type: 'table', caption: '表1 引用文档', rows: 1, cols: 2, headers: ['a', 'b'], data: [['1', '2']], },
      { type: 'image', imagePath: 'x.png', caption: '图2　系统组成' },
      { type: 'mermaid', caption: '图3 流程图', code: 'graph TD\nA-->B' },
      { type: 'unorderedList', items: ['条目'] }
    )
    root.addChild(section)
    const instructions = serializeToInstructions(new DocumentTree(root), styleDef)
    const kinds = instructions.map((i) =>
      i.opType === 'InsertParagraph'
        ? `P:${i.styleName}:${i.content.text}`
        : `T:${i.content.rows}x${i.content.cols}`
    )
    expect(kinds).toEqual([
      'P:50:标识',
      'P:45:一段正文',
      'P:65:甲',
      'P:65:乙',
      'P:48:引用文档', // 表题注在上，手写"表1 "已剥离
      'T:1x2',
      'P:45:[图片: x.png]',
      'P:60:系统组成', // 图题注在下，"图2　"已剥离
      'P:45:[Mermaid 图表: graph TD\nA-->B]',
      'P:60:流程图',
      'P:62:条目'
    ])

    // 列表组：两个列表块各独立组 id（1、2），组内共享
    const listParas = instructions.filter(
      (i): i is Extract<WriteInstruction, { opType: 'InsertParagraph' }> =>
        i.opType === 'InsertParagraph' && i.listGroupId > 0
    )
    expect(listParas.map((p) => p.listGroupId)).toEqual([1, 1, 2])
  })

  it('空的文本/标题不产出段落', () => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    const section = node(2, '')
    section.contentBlocks.push({ type: 'text', content: '' })
    root.addChild(section)
    const instructions = serializeToInstructions(new DocumentTree(root), styleDef)
    expect(instructions).toHaveLength(0)
  })

  it('公式/代码以占位文本段落输出', () => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    const section = node(2, '附录')
    section.contentBlocks.push(
      { type: 'formula', latexCode: 'E=mc^2' },
      { type: 'code', language: 'cpp', code: 'int main(){}' }
    )
    root.addChild(section)
    const instructions = serializeToInstructions(new DocumentTree(root), styleDef)
    expect(
      instructions.map((i) => (i.opType === 'InsertParagraph' ? i.content.text : ''))
    ).toEqual(['附录', 'E=mc^2', 'int main(){}'])
  })
})
