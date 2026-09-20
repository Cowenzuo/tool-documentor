/** serializer.test.ts — 文档树转写入指令的序列化单测。 */

import { describe, expect, it } from 'vitest'
import { resetIdCounterForTest } from '@documentor/core/idgen'
import { DocumentNode, DocumentTree } from '@documentor/core/tree'
import { serializeToInstructions, serializeWithWarnings, collectMermaidFigures } from '../src/serializer'
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
        : i.opType === 'InsertTable'
          ? `T:${i.content.rows}x${i.content.cols}`
          : 'IMG'
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

  it('图片/图形段落样式：figure 键优先，缺省回退 body（向后兼容）', () => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    const section = node(2, '标识')
    section.contentBlocks.push(
      { type: 'image', imagePath: 'x.png', caption: '图1 示例' },
      { type: 'mermaid', code: 'graph TD\nA-->B', caption: '图2 流程' }
    )
    root.addChild(section)
    const tree = new DocumentTree(root)
    const paraStyles = (s: typeof styleDef): string[] =>
      serializeToInstructions(tree, s)
        .filter((i) => i.opType === 'InsertParagraph')
        .map((i) => i.styleName)

    // 样式表无 figure 键 → 图片/图形占位段落仍用 body（老样式表行为不变）
    expect(paraStyles(styleDef)).toEqual(['50', '45', '60', '45', '60'])
    // 提供 figure 键 → 图片/图形段落用它，题注仍用 figure.caption
    expect(paraStyles({ ...styleDef, styleMap: { ...styleDef.styleMap, figure: '70' } })).toEqual([
      '50',
      '70',
      '60',
      '70',
      '60'
    ])
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

  it('样式键缺失时 warnings 透出（指令仍生成，不静默）', () => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    const section = node(4, '四级标题')
    // 测试 styleDef 缺 heading.4 / body
    section.contentBlocks.push({ type: 'text', content: '正文' })
    root.addChild(section)
    const { instructions, warnings } = serializeWithWarnings(new DocumentTree(root), styleDef)
    expect(instructions).toHaveLength(2)
    expect(warnings.length).toBeGreaterThanOrEqual(1)
    expect(warnings.some((w) => w.includes('标题的样式未生效'))).toBe(true)
    // serializeToInstructions 行为不变（无 warnings 参数）
  })
})

describe('题注编号方式（captionNumbering）', () => {
  const buildTree = (): DocumentTree => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    const n = node(1, '范围')
    n.contentBlocks.push({
      type: 'table',
      caption: '表4.1-1 示例表',
      rows: 1,
      cols: 1,
      headers: ['A'],
      data: [['1']]
    })
    n.contentBlocks.push({ type: 'image', imagePath: 'images/x.png', caption: '图4.1-1 示例图' })
    root.addChild(n)
    return new DocumentTree(root)
  }
  const captionTexts = (style: StyleTemplateDef): string[] =>
    serializeToInstructions(buildTree(), style)
      .filter(
        (i): i is Extract<WriteInstruction, { opType: 'InsertParagraph' }> =>
          i.opType === 'InsertParagraph'
      )
      .filter(
        (i) =>
          i.styleName === style.styleMap['table.caption'] ||
          i.styleName === style.styleMap['figure.caption']
      )
      .map((i) => i.content.text)

  it('默认 auto：剥离手写序号，交由 Word 样式编号', () => {
    expect(captionTexts(styleDef)).toEqual(['示例表', '示例图'])
  })

  it('static：题注文本原样保留（样式不再编号）', () => {
    expect(
      captionTexts({ ...styleDef, captionNumbering: { table: 'static', figure: 'static' } })
    ).toEqual(['表4.1-1 示例表', '图4.1-1 示例图'])
  })

  it('field：输出题注域指令（章节号 STYLEREF + 本节序号 SEQ），剥离手写序号', () => {
    const style: StyleTemplateDef = {
      ...styleDef,
      headingStarts: [4, 1, 1, 1, 1],
      captionNumbering: {
        table: 'field',
        figure: 'field',
        chapterStyleNames: { '1': '标题 1', '2': '标题 2' }
      }
    }
    const caps = serializeToInstructions(buildTree(), style).filter(
      (i): i is Extract<WriteInstruction, { opType: 'InsertCaption' }> =>
        i.opType === 'InsertCaption'
    )
    // 节点为标题 1：章节号取「4」，序号按标题 1 重启
    expect(caps).toHaveLength(2)
    expect(caps[0]).toEqual({
      opType: 'InsertCaption',
      styleName: '48',
      content: {
        label: '表',
        chapterStyleName: '标题 1',
        chapterText: '4',
        seqName: '表',
        seqRestartLevel: 1,
        seqText: '1',
        title: '示例表'
      }
    })
    expect(caps[1]!.content.label).toBe('图')
    expect(caps[1]!.content.seqName).toBe('图')
    expect(caps[1]!.content.title).toBe('示例图')
  })

  it('field：多级标题下章节号与每节序号正确（4.1 / 4.1.1）', () => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    const h1 = node(1, '第四章')
    const h2 = node(2, '第一节')
    const h3 = node(3, '第一小节')
    h2.contentBlocks.push({
      type: 'table',
      caption: '表4.1-1 工况表',
      rows: 1,
      cols: 1,
      headers: ['A'],
      data: [['1']]
    })
    h3.contentBlocks.push({
      type: 'table',
      caption: '表4.1.1-1 特征值',
      rows: 1,
      cols: 1,
      headers: ['A'],
      data: [['1']]
    })
    h3.contentBlocks.push({
      type: 'table',
      caption: '表4.1.1-2 特征值二',
      rows: 1,
      cols: 1,
      headers: ['A'],
      data: [['1']]
    })
    h2.addChild(h3)
    h1.addChild(h2)
    root.addChild(h1)
    const style: StyleTemplateDef = {
      ...styleDef,
      headingStarts: [4, 1, 1, 1, 1],
      captionNumbering: {
        table: 'field',
        chapterStyleNames: { '2': '标题 2', '3': '标题 3' }
      }
    }
    const caps = serializeToInstructions(new DocumentTree(root), style).filter(
      (i): i is Extract<WriteInstruction, { opType: 'InsertCaption' }> =>
        i.opType === 'InsertCaption'
    )
    expect(
      caps.map((c) => [c.content.chapterText, c.content.seqRestartLevel, c.content.seqText])
    ).toEqual([
      ['4.1', 2, '1'],
      ['4.1.1', 3, '1'],
      ['4.1.1', 3, '2']
    ])
  })
})

describe('Mermaid 降级占位段：写进 Word 的内容与「以文本形式导出」一致', () => {
  const mermaidTree = (code: string): DocumentTree => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    const section = node(2, '标识')
    section.contentBlocks.push({ type: 'mermaid', caption: '图1 流程', code })
    root.addChild(section)
    return new DocumentTree(root)
  }
  const placeholder = (tree: DocumentTree): string => {
    const hit = serializeToInstructions(tree, styleDef)
      .filter(
        (i): i is Extract<WriteInstruction, { opType: 'InsertParagraph' }> =>
          i.opType === 'InsertParagraph'
      )
      .map((i) => i.content.text)
      .find((text) => text.startsWith('[Mermaid'))
    expect(hit).toBeDefined()
    return hit!
  }

  it('源码不长时整段照抄（旧实现固定切前 60 字符，尾部无声丢失）', () => {
    const code = ['graph TD', ...Array.from({ length: 24 }, (_, i) => `  A${i} --> A${i + 1}`)].join('\n')
    expect(code.length).toBeGreaterThan(260) // review S8 的实测样本量级
    const text = placeholder(mermaidTree(code))
    expect(text).toBe(`[Mermaid 图表: ${code}]`)
    // 尾行还在 → 尾部没有丢
    expect(text).toContain(`A23 --> A24`)
  })

  it('超长源码：按行截断并写明「已截断」与真实长度，不留半截 token', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `  N${i} --> N${i + 1}`)
    const code = `graph TD\n${lines.join('\n')}`
    const text = placeholder(mermaidTree(code))
    expect(code.length).toBeGreaterThan(2000) // 超过占位段上限才截断
    expect(text.startsWith('[Mermaid 图表: ')).toBe(true) // 嵌入链路的槽位标记前缀不变
    expect(text).toContain('已截断')
    expect(text).toContain(`源码共 ${code.length} 字符`)
    expect(text).toContain('完整源码见工程文件')
    // 保留部分按整行切：最后一行与源码里的某一行逐字相同，不是半截 token
    const kept = text.slice('[Mermaid 图表: '.length, text.indexOf('（已截断'))
    expect(lines).toContain(kept.split('\n').at(-1)!)
    expect(kept.length).toBeGreaterThan(1000)
  })
})

describe('表格形状警告（导出侧不再静默）', () => {
  /** 造一棵只有一张表的树：表头 3 列、cols=2、第 2 行 4 列 */
  const raggedTree = (caption: string): DocumentTree => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    const section = node(2, '标识')
    section.contentBlocks.push({
      type: 'table',
      caption,
      rows: 2,
      cols: 2,
      headers: ['序号', '标识', '标题'],
      data: [
        ['1', 'DEMO-001'],
        ['2', 'DEMO-002', '示例', '多出来的一列']
      ]
    })
    root.addChild(section)
    return new DocumentTree(root)
  }

  it('表头与 cols 不一致、某行超宽：warnings 报出这处问题并指明是哪张表', () => {
    const { instructions, warnings } = serializeWithWarnings(raggedTree('表2 参差表'), styleDef)
    // 警告不阻断导出：表照常写出去
    expect(instructions.filter((i) => i.opType === 'InsertTable')).toHaveLength(1)
    expect(warnings).toHaveLength(1)
    const warn = warnings[0]!
    expect(warn).toContain('表格“表2 参差表”')
    expect(warn).toContain('表头 3 列与列数 2 不一致')
    expect(warn).toContain('第 2 行 4 列与列数 2 不一致')
    // 给用户看的文案不带内部字段名
    expect(warn).not.toContain('cols')
    expect(warn).not.toContain('data[')
  })

  it('形状一致的表不产生警告', () => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    const section = node(2, '标识')
    section.contentBlocks.push({
      type: 'table',
      caption: '表3 规整表',
      rows: 1,
      cols: 2,
      headers: ['序号', '标识'],
      data: [['1', 'DEMO-001']]
    })
    root.addChild(section)
    const { warnings } = serializeWithWarnings(new DocumentTree(root), styleDef)
    expect(warnings).toEqual([])
  })

  it('没有表题注时用节点标题定位', () => {
    const { warnings } = serializeWithWarnings(raggedTree(''), styleDef)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('“标识”下的表格')
    expect(warnings[0]).toContain('表头 3 列与列数 2 不一致')
  })
})

describe('collectMermaidFigures（M7 图嵌入收集）', () => {
  it('按文档顺序收集 code 非空的 Mermaid 块（跳过空代码）', () => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    const a = node(1, '范围')
    a.contentBlocks.push(
      { type: 'mermaid', caption: '图1 结构', code: 'graph TD\nA-->B' },
      { type: 'mermaid', caption: '图2 空', code: '' } // 无占位段，不收集
    )
    const b = node(2, '标识')
    b.contentBlocks.push({ type: 'mermaid', caption: '图3 流程', code: 'flowchart LR\nA-->B' })
    const c = node(1, '附录')
    c.addChild(b) // 子节点在块之后
    root.addChild(a)
    root.addChild(c)

    const figures = collectMermaidFigures(new DocumentTree(root))
    expect(figures).toEqual([
      { nodeTitle: '范围', caption: '图1 结构', code: 'graph TD\nA-->B' },
      { nodeTitle: '标识', caption: '图3 流程', code: 'flowchart LR\nA-->B' }
    ])
  })

  it('与非收集路径的占位段一一对应（文本前缀 [Mermaid）', () => {
    resetIdCounterForTest()
    const root = new DocumentNode(0)
    const s = node(2, '标识')
    s.contentBlocks.push({ type: 'mermaid', caption: '图1 数据流', code: 'graph TD\nA-->B' })
    root.addChild(s)
    const instructions = serializeToInstructions(new DocumentTree(root), styleDef)
    const placeholders = instructions.filter(
      (i): i is Extract<WriteInstruction, { opType: 'InsertParagraph' }> =>
        i.opType === 'InsertParagraph' && i.content.text.startsWith('[Mermaid')
    )
    expect(placeholders).toHaveLength(1)
    expect(collectMermaidFigures(new DocumentTree(root))).toHaveLength(1)
  })
})

