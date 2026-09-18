/**
 * 内容块展示常量（标签/徽标字符/代码语言）。
 */
import type { BlockTypeName, ContentBlock } from '@documentor/core/blocks'

export const BLOCK_TYPE_LABELS: Record<BlockTypeName, string> = {
  text: '文本',
  image: '图片',
  table: '表格',
  formula: '公式',
  code: '代码',
  mermaid: '流程图',
  orderedList: '有序列表',
  unorderedList: '无序列表'
}

export const BLOCK_TYPE_BADGES: Record<BlockTypeName, string> = {
  text: '文',
  image: '图',
  table: '表',
  formula: '公',
  code: '码',
  mermaid: 'M',
  orderedList: '序',
  unorderedList: '项'
}

export const BLOCK_ADD_ORDER: BlockTypeName[] = [
  'text',
  'image',
  'table',
  'formula',
  'code',
  'mermaid',
  'orderedList',
  'unorderedList'
]

export const CODE_LANGUAGES = [
  'cpp',
  'python',
  'javascript',
  'java',
  'csharp',
  'sql',
  'bash',
  'plain'
] as const

export const CODE_LANGUAGE_LABELS: Record<string, string> = {
  cpp: 'C++',
  python: 'Python',
  javascript: 'JavaScript',
  java: 'Java',
  csharp: 'C#',
  sql: 'SQL',
  bash: 'Bash/Shell',
  plain: '纯文本'
}

// 表格尺寸上限已下沉到 @documentor/core（table-limits.ts），界面从那里导入。
// 这里不再保留副本，避免两处数字各自漂移。

/** 空块时向用户展示的类型说明 */
export function describeBlockType(type: BlockTypeName): string {
  switch (type) {
    case 'text':
      return '多行文本段落'
    case 'image':
      return '插入图片，题注自动生成'
    case 'table':
      return '表格，表名显示在表上方'
    case 'formula':
      return '数学公式'
    case 'code':
      return '代码，带语言标注'
    case 'mermaid':
      return '流程图或关系图，自动渲染'
    case 'orderedList':
      return '有序列表，每行一项'
    case 'unorderedList':
      return '无序列表，每行一项'
  }
}

/** 折叠时显示的一行摘要：让收起后的卡片还说得出自己是什么 */
export function summarizeBlock(block: ContentBlock): string {
  const firstLine = (text: string): string => text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? ''
  const cut = (text: string, max = 80): string => {
    const one = firstLine(text) || text.trim()
    return one.length > max ? `${one.slice(0, max)}…` : one
  }
  switch (block.type) {
    case 'text':
      return cut(block.content) || '（空段落）'
    case 'image':
      return block.caption || block.imagePath || '（未选择图片）'
    case 'table': {
      const cols = Math.max(block.headers.length, ...block.data.map((row) => row.length), block.cols, 0)
      const size = `${block.data.length} 行 × ${cols} 列`
      return block.caption ? `${block.caption} · ${size}` : size
    }
    case 'formula':
      return cut(block.latexCode) || '（空公式）'
    case 'code': {
      const lang = CODE_LANGUAGE_LABELS[block.language] ?? block.language
      const head = cut(block.code, 60)
      return head ? `${lang ? `${lang} · ` : ''}${head}` : lang || '（空代码）'
    }
    case 'mermaid':
      return block.caption ? `${block.caption} · ${cut(block.code, 50)}` : cut(block.code, 70) || '（空图）'
    case 'orderedList':
    case 'unorderedList':
      return block.items.length > 0 ? `${block.items.length} 项 · ${cut(block.items[0] ?? '', 60)}` : '（空列表）'
  }
}
