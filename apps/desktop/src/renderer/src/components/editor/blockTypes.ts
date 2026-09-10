/**
 * 内容块展示常量（标签/徽标字符/代码语言）。
 */
import type { BlockTypeName } from '@documentor/core/blocks'

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

export const TABLE_MAX_ROWS = 50
export const TABLE_MAX_COLS = 20

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
