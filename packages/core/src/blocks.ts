/**
 * 内容块：8 种类型（对齐旧版 BlockType 枚举顺序 0..7 与 props 字段）。
 * 与旧 C++ 版（contentblock.h）语义一致：
 * kText=0 kImage=1 kTable=2 kFormula=3 kCode=4 kMermaid=5 kOrderedList=6 kUnorderedList=7
 */

export const BLOCK_TYPE_NAMES = [
  'text',
  'image',
  'table',
  'formula',
  'code',
  'mermaid',
  'orderedList',
  'unorderedList'
] as const

export type BlockTypeName = (typeof BLOCK_TYPE_NAMES)[number]

/** 与 db content_block.block_type 的数字字符串（'0'..'7'）互转 */
export function blockTypeIndex(name: BlockTypeName): number {
  return BLOCK_TYPE_NAMES.indexOf(name)
}

export function blockTypeName(index: number | string): BlockTypeName {
  const i = typeof index === 'string' ? Number.parseInt(index, 10) : index
  const name = BLOCK_TYPE_NAMES[i]
  if (!name) throw new Error(`未知内容块类型: ${index}`)
  return name
}

export interface TextBlockProps {
  content: string
}

export interface ImageBlockProps {
  /** 相对工程 images/ 的文件名（uuid.<ext>） */
  imagePath: string
  caption: string
}

export interface TableBlockProps {
  caption: string
  rows: number
  cols: number
  headers: string[]
  /** 每行一个单元格数组（行数可与 rows 不同步，以实际为准） */
  data: string[][]
}

export interface FormulaBlockProps {
  latexCode: string
}

export interface CodeBlockProps {
  language: string
  code: string
}

export interface MermaidBlockProps {
  caption: string
  code: string
}

export interface ListBlockProps {
  items: string[]
}

export type ContentBlock =
  | ({ type: 'text' } & TextBlockProps)
  | ({ type: 'image' } & ImageBlockProps)
  | ({ type: 'table' } & TableBlockProps)
  | ({ type: 'formula' } & FormulaBlockProps)
  | ({ type: 'code' } & CodeBlockProps)
  | ({ type: 'mermaid' } & MermaidBlockProps)
  | ({ type: 'orderedList' } & ListBlockProps)
  | ({ type: 'unorderedList' } & ListBlockProps)

/** 各具体块类型（判别联合成员别名，供编辑器/序列化器按类型收窄） */
export type TextBlock = Extract<ContentBlock, { type: 'text' }>
export type ImageBlock = Extract<ContentBlock, { type: 'image' }>
export type TableBlock = Extract<ContentBlock, { type: 'table' }>
export type FormulaBlock = Extract<ContentBlock, { type: 'formula' }>
export type CodeBlock = Extract<ContentBlock, { type: 'code' }>
export type MermaidBlock = Extract<ContentBlock, { type: 'mermaid' }>
export type OrderedListBlock = Extract<ContentBlock, { type: 'orderedList' }>
export type UnorderedListBlock = Extract<ContentBlock, { type: 'unorderedList' }>
export type ListBlock = OrderedListBlock | UnorderedListBlock

export type BlockPropsMap = {
  text: TextBlockProps
  image: ImageBlockProps
  table: TableBlockProps
  formula: FormulaBlockProps
  code: CodeBlockProps
  mermaid: MermaidBlockProps
  orderedList: ListBlockProps
  unorderedList: ListBlockProps
}

/** 默认空块（UI 添加块时使用） */
export function createBlock<T extends BlockTypeName>(type: T): ContentBlock & { type: T } {
  const base: Record<string, unknown> = { type }
  switch (type) {
    case 'text':
      base['content'] = ''
      break
    case 'formula':
      base['latexCode'] = ''
      break
    case 'image':
      base['imagePath'] = ''
      base['caption'] = ''
      break
    case 'table':
      base['caption'] = ''
      base['rows'] = 0
      base['cols'] = 0
      base['headers'] = []
      base['data'] = []
      break
    case 'code':
      base['language'] = ''
      base['code'] = ''
      break
    case 'mermaid':
      base['caption'] = ''
      base['code'] = ''
      break
    case 'orderedList':
    case 'unorderedList':
      base['items'] = []
      break
  }
  return base as unknown as ContentBlock & { type: T }
}

/**
 * 块 → db props_json 对象（不含 type；键与旧版 projectstore 一致：
 * content / imagePath+caption / caption+rows+cols+headers+data / latexCode /
 * language+code / caption+code / items）
 */
export function propsOf(block: ContentBlock): Record<string, unknown> {
  const { type: _type, ...rest } = block
  return rest as Record<string, unknown>
}

/** db props_json + block_type（数字字符串）→ 块对象 */
export function blockFromDb(type: string | number, props: Record<string, unknown>): ContentBlock {
  const name = blockTypeName(type)
  const rest = { ...props }
  switch (name) {
    case 'text': {
      const content = rest['content']
      return { type: name, content: str(content) }
    }
    case 'image':
      return { type: name, imagePath: str(rest['imagePath']), caption: str(rest['caption']) }
    case 'table':
      return {
        type: name,
        caption: str(rest['caption']),
        rows: num(rest['rows']),
        cols: num(rest['cols']),
        headers: strArray(rest['headers']),
        data: (rest['data'] as unknown[] | undefined ?? []).map((row) =>
          Array.isArray(row) ? row.map((c) => str(c)) : []
        )
      }
    case 'formula':
      return { type: name, latexCode: str(rest['latexCode']) }
    case 'code':
      return { type: name, language: str(rest['language']), code: str(rest['code']) }
    case 'mermaid':
      return { type: name, caption: str(rest['caption']), code: str(rest['code']) }
    case 'orderedList':
    case 'unorderedList':
      return { type: name, items: strArray(rest['items']) }
  }
}

/** 深拷贝（纯数据） */
export function cloneBlock(block: ContentBlock): ContentBlock {
  return blockFromDb(blockTypeIndex(block.type), JSON.parse(JSON.stringify(propsOf(block))))
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number.parseInt(str(v), 10) || 0
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => str(x))
}
