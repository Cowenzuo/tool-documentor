/**
 * block-convert.ts — 换类型：把一块的内容搬到另一种类型上（口径见 PLAN-20）。
 *
 * 用户拍板的口径是"能搬的都搬过去"，落到数据上是三条：
 *   1. 每种类型有一处**主文本**，按行读出、按行写回。表格是二维的，一行一格、格间用制表符，
 *      这样表格与文本／列表之间往返不丢字；图片没有主文本这一处地方；
 *   2. **题注**按目标的收法走：目标自己有题注位（表格／图片／流程图）就进那个位子；
 *      目标没有题注位但主文本是自由的（文本／列表／代码）就当第一行／第一项；
 *      主文本带语法又没题注位的（公式）装不下，丢掉并问一句；
 *   3. 表格的形状（列数、表头、纵向合并）与图片的文件引用不跟过去，这是"换类型"三个字的定义。
 *
 * 返回里带两样给界面用：`losesText` 说"有字没地方放"，界面只在它为真时问一句；
 * `dropped` 逐条说明没跟过来的是什么，界面拿来写那句确认，写入命令拿来记日志。
 *
 * 纯数据、不带界面依赖，与 `table-limits.ts` 同一个理由：界面与工程工作区的写入命令用同一份。
 */
import { cloneBlock, type BlockLockLevel, type BlockTypeName, type ContentBlock } from './blocks'

/** 目标类型有没有"主文本"这一处地方：图片没有，字进不去 */
const HAS_MAIN_TEXT: Record<BlockTypeName, boolean> = {
  text: true,
  image: false,
  table: true,
  formula: true,
  code: true,
  mermaid: true,
  orderedList: true,
  unorderedList: true
}

/** 目标类型自己有题注位（表格的表名、图片的图名、流程图的图名） */
const HAS_CAPTION_SLOT: Record<BlockTypeName, boolean> = {
  text: false,
  image: true,
  table: true,
  formula: false,
  code: false,
  mermaid: true,
  orderedList: false,
  unorderedList: false
}

/** 目标类型没有题注位、但主文本是自由的：题注当第一行／第一项塞得进去 */
const MAIN_TEXT_TAKES_CAPTION: Record<BlockTypeName, boolean> = {
  text: true,
  image: false,
  table: false,
  formula: false,
  code: true,
  mermaid: false,
  orderedList: true,
  unorderedList: true
}

/** 换类型的结果 */
export interface BlockConversion {
  /** 换好的新块；档位 `lock` 原样跟着走 */
  block: ContentBlock
  /** 有字没地方放（正文或题注会丢）：界面据此问一句 */
  losesText: boolean
  /** 没跟过来的是什么，逐条给人看的说法 */
  dropped: string[]
}

/**
 * 主文本：按行读出来。
 * 表格把表头（有字时）与每一行各读成一行、格间用制表符；图片没有主文本。
 */
export function blockLines(block: ContentBlock): string[] {
  switch (block.type) {
    case 'text':
      return splitLines(block.content)
    case 'orderedList':
    case 'unorderedList':
      return [...block.items]
    case 'code':
      return splitLines(block.code)
    case 'formula':
      return splitLines(block.latexCode)
    case 'mermaid':
      return splitLines(block.code)
    case 'table': {
      const lines: string[] = []
      if (block.headers.some((cell) => cell.trim() !== '')) lines.push(block.headers.join('\t'))
      for (const row of block.data) lines.push(row.join('\t'))
      return lines
    }
    case 'image':
      return []
  }
}

/** 题注：只有表格、图片、流程图有 */
export function blockCaption(block: ContentBlock): string {
  switch (block.type) {
    case 'table':
    case 'image':
    case 'mermaid':
      return block.caption
    case 'text':
    case 'formula':
    case 'code':
    case 'orderedList':
    case 'unorderedList':
      return ''
  }
}

/**
 * 换类型。
 *
 * 同一类型直接返回一份等值的块（调用方不该拿它当"改内容"用），不算丢东西。
 */
export function convertBlock(block: ContentBlock, to: BlockTypeName): BlockConversion {
  if (block.type === to) return { block: cloneBlock(block), losesText: false, dropped: [] }

  const lines = blockLines(block)
  const caption = blockCaption(block)
  const hasCaption = caption.trim() !== ''
  // 题注的三个去处：进目标的题注位、当主文本的第一行、装不下就丢
  const captionToSlot = hasCaption && HAS_CAPTION_SLOT[to]
  const captionToText = hasCaption && !captionToSlot && MAIN_TEXT_TAKES_CAPTION[to]
  const carried = captionToText ? [caption, ...lines] : lines

  const dropped: string[] = []
  let losesText = false
  if (!HAS_MAIN_TEXT[to] && lines.some((line) => line.trim() !== '')) {
    losesText = true
    dropped.push('这一块的内容')
  }
  if (hasCaption && !captionToSlot && !captionToText) {
    losesText = true
    dropped.push('题注')
  }
  if (block.type === 'image' && block.imagePath !== '') dropped.push('图片引用')
  if (block.type === 'code' && block.language !== '') dropped.push('代码语言标注')
  if (block.type === 'table') {
    if (block.cols > 1 || block.headers.some((cell) => cell.trim() !== '')) dropped.push('表头与列结构')
    if (block.rowSpans !== undefined || block.mergeVertical === true) dropped.push('纵向合并')
  }

  const next = writeLines(to, carried, captionToSlot ? caption : '')
  return { block: withLock(next, block.lock), losesText, dropped }
}

/** 按行写进目标类型的主文本位；有题注位的目标顺手把题注放回位子 */
function writeLines(to: BlockTypeName, lines: string[], caption: string): ContentBlock {
  const text = lines.join('\n')
  switch (to) {
    case 'text':
      return { type: to, content: text }
    case 'orderedList':
    case 'unorderedList':
      // 空行当不了一项：列表里没有"空的一项"这回事
      return { type: to, items: lines.filter((line) => line.trim() !== '') }
    case 'code':
      return { type: to, language: '', code: text }
    case 'formula':
      return { type: to, latexCode: text.trim() }
    case 'mermaid':
      return { type: to, caption, code: text }
    case 'table': {
      /**
       * 一行一格；行里有制表符就按制表符分列，并把每行补齐到同一个列数。
       * 不猜逗号与空格：那是照着我们自己的读写口径往回拆，不是猜用户的意思。
       * 列数至少 1：写入侧的表格形状校验不许 cols 为 0。
       */
      const rows = lines.map((line) => line.split('\t'))
      const cols = Math.max(1, ...rows.map((row) => row.length))
      return {
        type: to,
        caption,
        rows: rows.length,
        cols,
        headers: [],
        data: rows.map((row) => padRow(row, cols))
      }
    }
    case 'image':
      // 字进不去图片：主文本丢了（确认过才走到这里），题注有自己的位子
      return { type: to, imagePath: '', caption }
  }
}

function padRow(row: string[], cols: number): string[] {
  if (row.length >= cols) return row
  return [...row, ...Array.from({ length: cols - row.length }, () => '')]
}

function withLock(block: ContentBlock, lock: BlockLockLevel | undefined): ContentBlock {
  return lock === undefined ? block : ({ ...block, lock } as ContentBlock)
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split(/\r?\n/)
}
