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
  const i = BLOCK_TYPE_NAMES.indexOf(name)
  // 写库前必须拦住：历史上写成 -1 会让整个工程再也打不开（load 时抛错）
  if (i < 0) throw new Error(`未知内容块类型: ${String(name)}`)
  return i
}

/**
 * 宽松解析：数字字符串（'0'..'7'）、数字下标、类型名都接受，不认识返回 null。
 * 读库侧用它，遇到无法识别的历史数据只跳过这一块，不让整个工程打不开。
 */
export function parseBlockType(type: number | string): BlockTypeName | null {
  if (typeof type === 'number') {
    return Number.isInteger(type) ? BLOCK_TYPE_NAMES[type] ?? null : null
  }
  const raw = type.trim()
  if ((BLOCK_TYPE_NAMES as readonly string[]).includes(raw)) {
    return raw as BlockTypeName
  }
  const i = Number.parseInt(raw, 10)
  return Number.isInteger(i) ? BLOCK_TYPE_NAMES[i] ?? null : null
}

export function blockTypeName(index: number | string): BlockTypeName {
  const name = parseBlockType(index)
  if (!name) throw new Error(`未知内容块类型: ${index}`)
  return name
}

/**
 * 模板锁档位（模板节点定义的 contentBlocks[].lock 带过来，随块进工程数据）：
 * - `type` 只锁类型：内容可改，类型不能改，可删可挪；
 * - `keep` 类型锁住且必须存在：内容可改，不能改类型、不能删、不能挪；
 * - `readonly` 整块只读：内容也由模板给定。
 * 不写就是不锁，与没有这个字段的老数据完全一致。
 */
export const BLOCK_LOCK_LEVELS = ['type', 'keep', 'readonly'] as const

export type BlockLockLevel = (typeof BLOCK_LOCK_LEVELS)[number]

/** 每类内容块都可带的可选模板锁 */
export interface BlockLockProps {
  lock?: BlockLockLevel
}

/**
 * 宽松解析模板锁：只认 type / keep / readonly 三个字符串。
 * 读库侧用它，非法值一律丢弃（按不锁处理），不让脏数据把界面锁死。
 */
export function parseBlockLock(value: unknown): BlockLockLevel | undefined {
  if (typeof value !== 'string') return undefined
  const raw = value.trim()
  return (BLOCK_LOCK_LEVELS as readonly string[]).includes(raw)
    ? (raw as BlockLockLevel)
    : undefined
}

export interface TextBlockProps {
  content: string
}

export interface ImageBlockProps {
  /** 相对工程目录的图片路径，惯例是 images/uuid.<ext>；只记文件名是历史脏数据 */
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
  /**
   * 纵向合并跨度（显式表示，跨行不靠内容推断）。
   * 形状：{ 列号: [[起始行, 跨几行], ...] }，行号按 data 下标（不含表头）。
   * 合并只影响显示与导出，**不改动 data 里的值**——值保留，取消合并即可恢复。
   * 缺省时不写：此时按 mergeVertical 的"同列连续相同值"兼容判定。
   */
  rowSpans?: Record<string, Array<[number, number]>>
  /**
   * 遗留开关：同列中**连续**且 trim 后非空、内容完全相同的单元格合并为一个；表头行不参与。
   * 老数据与模板仍在用；有新跨度时以 rowSpans 为准。判定见 core/table-merge.ts。
   */
  mergeVertical?: boolean
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
  | ({ type: 'text' } & TextBlockProps & BlockLockProps)
  | ({ type: 'image' } & ImageBlockProps & BlockLockProps)
  | ({ type: 'table' } & TableBlockProps & BlockLockProps)
  | ({ type: 'formula' } & FormulaBlockProps & BlockLockProps)
  | ({ type: 'code' } & CodeBlockProps & BlockLockProps)
  | ({ type: 'mermaid' } & MermaidBlockProps & BlockLockProps)
  | ({ type: 'orderedList' } & ListBlockProps & BlockLockProps)
  | ({ type: 'unorderedList' } & ListBlockProps & BlockLockProps)

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
    default:
      // 拦住"凭空造块"：调用方传了枚举外的类型时立刻报错，而不是存进库变成打不开的工程
      throw new Error(`未知内容块类型: ${String(type)}`)
  }
  return base as unknown as ContentBlock & { type: T }
}

/**
 * 块 → db props_json 对象（不含 type；键与旧版 projectstore 一致：
 * content / imagePath+caption / caption+rows+cols+headers+data / latexCode /
 * language+code / caption+code / items）。可选字段 lock 一并落库。
 */
export function propsOf(block: ContentBlock): Record<string, unknown> {
  const { type: _type, ...rest } = block
  return rest as Record<string, unknown>
}

/** db props_json + block_type（数字字符串）→ 块对象 */
export function blockFromDb(type: string | number, props: Record<string, unknown>): ContentBlock {
  const name = blockTypeName(type)
  const rest = { ...props }
  const block = blockOfProps(name, rest)
  // 模板锁随 props_json 落库读回；非法值丢弃，按不锁处理（老数据没有这个键）
  const lock = parseBlockLock(rest['lock'])
  return lock ? ({ ...block, lock } as ContentBlock) : block
}

/** 按类型把 props 还原成块（不含 lock，由 blockFromDb 统一补） */
function blockOfProps(name: BlockTypeName, rest: Record<string, unknown>): ContentBlock {
  switch (name) {
    case 'text': {
      const content = rest['content']
      return { type: name, content: str(content) }
    }
    case 'image':
      return { type: name, imagePath: str(rest['imagePath']), caption: str(rest['caption']) }
    case 'table': {
      const block: TableBlock = {
        type: name,
        caption: str(rest['caption']),
        rows: num(rest['rows']),
        cols: num(rest['cols']),
        headers: strArray(rest['headers']),
        data: (rest['data'] as unknown[] | undefined ?? []).map((row) =>
          Array.isArray(row) ? row.map((c) => str(c)) : []
        )
      }
      // 仅在开启时写入属性，保持既有工程 JSON 精简（老数据缺键=关闭）
      if (rest['mergeVertical'] === true) block.mergeVertical = true
      const spans = parseRowSpans(rest['rowSpans'])
      if (spans) block.rowSpans = spans
      return block
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

/**
 * 解析并规整 rowSpans：只接受 [[起始行, 跨几行], ...]，跨度 >= 2 才留。
 * 非法形状一律丢弃（视为没有显式跨度，退回兼容判定），不让脏数据把渲染带偏。
 */
function parseRowSpans(v: unknown): Record<string, Array<[number, number]>> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, Array<[number, number]>> = {}
  for (const [col, list] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const spans: Array<[number, number]> = []
    for (const item of list) {
      if (!Array.isArray(item) || item.length < 2) continue
      const start = num(item[0])
      const span = num(item[1])
      if (!Number.isInteger(start) || start < 0) continue
      if (!Number.isInteger(span) || span < 2) continue
      spans.push([start, span])
    }
    if (spans.length > 0) out[col] = spans
  }
  return Object.keys(out).length > 0 ? out : undefined
}
