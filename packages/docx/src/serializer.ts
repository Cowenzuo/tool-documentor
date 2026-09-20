/**
 * DocxSerializer：文档树 → 写入指令序列（对齐旧版 docxserializer.cpp 全规则）。
 * - 章节节点标题 → heading.<level> 段落（isSubTitle → subtitle.<depth>）
 * - kText → body；kTable → 表题注段 + 表格；kImage/kMermaid →
 *   占位段 + 图题注段（图名在图下方）；kFormula/kCode → body 占位文本；
 *   列表 → 每项一段 + 独立列表组 id（重新编号）
 * - 题注文字原样带出，编号归样式或题注域管
 * - 题注 field 模式：章节号按"当前路径上实际存在的标题层级"拼（缺层不补 0），
 *   没有可挂靠的标题时退化为不带章节号的静态题注文本；图表占位段整段带出源码（超长才截断并标注）
 * - warnings：样式键缺失时透出（配对软校验的兜底，不静默）；
 *   表格形状与声明列数对不上时也走这条通道（参差表不再静默导出）
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { DocumentTree, DocumentNode } from '@documentor/core'
import { checkTableShape } from '@documentor/core'
import type { ContentBlock, TableBlock, TableShapeIssue } from '@documentor/core'
import type { StyleTemplateDef, CaptionNumberingMode } from '@documentor/templates'
import type { WriteInstruction } from './instructions'

export interface SerializeOptions {
  /** 样式查找函数（默认用 styleDef.styleMap） */
  lookup?: (key: string) => string
  /** 工程目录（用于把 imagePath 解析为绝对路径并真正嵌入图片；缺省则输出占位文本） */
  imageBaseDir?: string
}

export interface SerializeResult {
  instructions: WriteInstruction[]
  /** 样式未生效明细（如：“附录”标题的样式未生效） */
  warnings: string[]
}

export function serializeToInstructions(
  tree: DocumentTree,
  styleDef: StyleTemplateDef | null,
  options?: SerializeOptions
): WriteInstruction[] {
  return serializeWithWarnings(tree, styleDef, options).instructions
}

export function serializeWithWarnings(
  tree: DocumentTree,
  styleDef: StyleTemplateDef | null,
  options?: SerializeOptions
): SerializeResult {
  const out: WriteInstruction[] = []
  const warnings: string[] = []
  if (!tree) return { instructions: out, warnings }
  let nextListGroupId = 1
  const lookup = (key: string): string => {
    if (options?.lookup) return options.lookup(key)
    return styleDef ? (styleDef.styleMap[key] ?? '') : ''
  }
  const look = (key: string, context: string): string => {
    const value = lookup(key)
    if (!value) warnings.push(`${context}的样式未生效，已按默认样式输出`)
    return value
  }
  /** 图片/图形段落样式：figure（可选键）→ 缺省回退 body（老样式表向后兼容，不报警） */
  const figureStyle = (context: string): string => {
    const value = lookup('figure')
    return value || look('body', context)
  }
  // 图片：工程目录可用且文件存在 → 输出真实图片指令；否则回退占位文本
  const resolveImage = (imagePath: string): string | null => {
    const base = options?.imageBaseDir
    if (!base || !imagePath) return null
    const abs = isAbsolute(imagePath) ? imagePath : resolve(base, imagePath)
    if (existsSync(abs)) return abs
    // 兼容只记了文件名的历史数据：图片实际都放在工程 images/ 下
    if (!isAbsolute(imagePath)) {
      const inImages = resolve(base, 'images', imagePath)
      if (existsSync(inImages)) return inImages
    }
    return null
  }

  // ---------- 题注编号状态 ----------
  const cn = styleDef?.captionNumbering
  const modeOf = (kind: CaptionKind): CaptionNumberingMode => cn?.[kind] ?? 'auto'
  const starts = styleDef?.headingStarts ?? []
  const startOf = (level: number): number => starts[level - 1] ?? 1
  const chapterNames = cn?.chapterStyleNames ?? {}
  /** 各标题层级当前编号（下标=层级，1 起） */
  const counters: number[] = []
  /**
   * 当前路径上实际存在的标题层级（升序，1 起）。副标题不入栈——它不占标题编号链，
   * 所以栈顶 = 题注能挂靠的最近一个普通标题层级；缺层也不入栈，章节号按它拼就不会补 0。
   */
  const headingPath: number[] = []
  /** 题注序号计数：key = `${kind}:${level}` */
  const seqCounters = new Map<string, number>()
  /** 「没有可用标题前置」只提示一次：逐条刷屏不会多给出信息 */
  let warnedNoChapter = false

  /** 进入标题节点：推进本层计数、重置更深层与相应题注序号（与 Word 多级列表语义一致） */
  const enterHeading = (level: number): void => {
    counters[level] = (counters[level] ?? startOf(level) - 1) + 1
    for (let d = level + 1; d <= MAX_HEADING_LEVEL; d++) counters[d] = startOf(d) - 1
    for (const key of [...seqCounters.keys()]) {
      if (Number(key.split(':')[1]) >= level) seqCounters.delete(key)
    }
    // 路径裁剪：同层或更深的标题已经翻篇，它下面的层级也不再生效
    while (headingPath.length > 0 && headingPath[headingPath.length - 1]! >= level) headingPath.pop()
    headingPath.push(level)
  }

  /**
   * 章节号 = 当前生效的标题层级编号，按层级顺序用 '.' 拼（栈里没有的层级不占位、不留分隔符）。
   * 为什么这么拼：章节号要跟着标题走，所以只拼"这一层真出现过"的编号——缺层（标题 1 直挂标题 3）
   * 不补 0；副标题不占编号链（只有普通标题进栈），它下面的题注挂到最近一个普通标题；
   * 一个可挂靠的标题都没有时返回 null（见 emitCaption）。结果只由当前路径与计数器决定，重复算逐字相同。
   */
  const chapterNumberOf = (): { level: number; text: string } | null => {
    const levels = headingPath.filter((l) => l >= 1 && l <= MAX_HEADING_LEVEL)
    if (levels.length === 0) return null
    const nums = levels
      .map((l) => counters[l])
      .filter((n): n is number => typeof n === 'number')
    if (nums.length === 0) return null
    return { level: levels[levels.length - 1]!, text: nums.join('.') }
  }

  /**
   * 题注（表题/图题），三种模式的题注文字都是原样带出：文字里只写标题，编号归样式或题注域。
   * - auto  → 序号由样式多级列表给出
   * - static→ 编号就写在题注文字里，原样输出
   * - field → STYLEREF(章节号) + SEQ(本节序号) 域，章节号随标题走且不占用标题列表；
   *   没有可挂靠的标题时退化为不带章节号的静态题注文本（见下方注释）
   */
  const emitCaption = (
    kind: CaptionKind,
    rawCaption: string,
    styleKey: string,
    context: string
  ): void => {
    const style = look(styleKey, context)
    const mode = modeOf(kind)
    // 题注文字原样带出：编号归样式或题注域，文字里只写标题，程序不剥离也不改动
    const title = rawCaption.trim()
    if (mode === 'static') {
      out.push(paragraph(style, title, 0))
      return
    }
    if (mode === 'auto') {
      out.push(paragraph(style, title, 0))
      return
    }
    const label = kind === 'table' ? '表' : '图'
    const chapter = chapterNumberOf()
    // SEQ 重启层级跟章节号同一层级；无章节号时按文档级序号排（重启层级 1）
    const level = chapter?.level ?? 1
    const seqKey = `${kind}:${level}`
    const seqText = String((seqCounters.get(seqKey) ?? 0) + 1)
    seqCounters.set(seqKey, Number(seqText))
    if (!chapter) {
      // 没有可挂靠的标题：不写章节号，序号仍由 SEQ 域给出（编号归域管，程序不自己造号）。
      // 章节号显式留空，writer 便不写那个固定的连字符，也就不会出现「表-1」这种残号。
      if (!warnedNoChapter) {
        warnedNoChapter = true
        warnings.push('部分题注所在位置没有可用的标题层级，已按不带章节号的题注导出')
      }
      out.push({
        opType: 'InsertCaption',
        styleName: style,
        content: {
          label,
          chapterStyleName: '',
          chapterText: '',
          seqName: label,
          seqRestartLevel: level,
          seqText,
          title
        }
      })
      return
    }
    const configured = chapterNames[String(level)]
    out.push({
      opType: 'InsertCaption',
      styleName: style,
      content: {
        label,
        // 模板未配置（undefined）= 按中文 Word 惯例「标题 N」；显式空串 = 不写域，用算好的章节号文本
        chapterStyleName: configured === undefined ? `标题 ${level}` : configured,
        chapterText: chapter.text,
        seqName: label,
        seqRestartLevel: level,
        seqText,
        title
      }
    })
  }

  const serializeNode = (node: DocumentNode): void => {
    const isHeading = !node.isRoot() && !node.isSubTitle && node.headingLevel > 0
    if (isHeading) enterHeading(node.headingLevel)

    // === 1. 节点标题 ===
    if (!node.isRoot() && node.title.length > 0) {
      if (node.isSubTitle) {
        out.push(
          paragraph(look(`subtitle.${node.subTitleDepth()}`, `“${node.title}”标题`), node.title, 0)
        )
      } else {
        out.push(
          paragraph(look(`heading.${node.headingLevel}`, `“${node.title}”标题`), node.title, 0)
        )
      }
    }

    // === 2. 内容块 ===
    for (const block of node.contentBlocks) {
      switch (block.type) {
        case 'text': {
          if (block.content.length > 0) {
            out.push(paragraph(look('body', `“${node.title}”的正文段落`), block.content, 0))
          }
          break
        }
        case 'orderedList':
        case 'unorderedList': {
          const listKey = block.type === 'orderedList' ? 'list.ordered.1' : 'list.unordered.1'
          const styleName = look(listKey, `“${node.title}”的列表`)
          const groupId = nextListGroupId++
          for (const item of block.items) {
            if (item.length === 0) continue
            out.push(paragraph(styleName, item, groupId))
          }
          break
        }
        case 'table': {
          // 形状先校验再写：表头长度、各行长度与 cols 对不上的表照样导出，
          // 但要把"哪张表、哪里对不上"报出去，不静默
          warnTableShape(node, block, warnings)
          if (block.caption.length > 0) {
            emitCaption('table', block.caption, 'table.caption', `“${node.title}”的表格题注`)
          }
          out.push({
            opType: 'InsertTable',
            content: {
              rows: block.rows,
              cols: block.cols,
              headers: [...block.headers],
              rowsData: block.data.map((row) => [...row]),
              headerStyle: look('table.header', `“${node.title}”的表格`),
              bodyStyle: look('table.body', `“${node.title}”的表格`),
              // 显式跨度原样透传（判定与摊平都在 writer 里统一做）
              ...(block.rowSpans ? { rowSpans: block.rowSpans } : {}),
              mergeVertical: block.mergeVertical === true
            }
          })
          break
        }
        case 'image': {
          const abs = block.imagePath.length > 0 ? resolveImage(block.imagePath) : null
          const style = figureStyle(`“${node.title}”的图片`)
          if (abs) {
            out.push({ opType: 'InsertImage', content: { srcPath: abs, styleName: style } })
          } else if (block.imagePath.length > 0) {
            out.push(paragraph(style, `[图片: ${block.imagePath}]`, 0))
          }
          if (block.caption.length > 0) {
            emitCaption('figure', block.caption, 'figure.caption', `“${node.title}”的图片题注`)
          }
          break
        }
        case 'mermaid': {
          if (block.code.length > 0) {
            out.push(
              paragraph(
                figureStyle(`“${node.title}”的流程图`),
                mermaidPlaceholder(block.code),
                0
              )
            )
          }
          if (block.caption.length > 0) {
            emitCaption('figure', block.caption, 'figure.caption', `“${node.title}”的图片题注`)
          }
          break
        }
        case 'formula':
        case 'code': {
          const text = blockText(block)
          out.push(paragraph(look('body', `节点“${node.title}”${blockLabel(block)}`), text, 0))
          break
        }
      }
    }

    // === 3. 递归子节点 ===
    for (const child of node.children) serializeNode(child)
  }

  for (const child of tree.root.children) serializeNode(child)
  return { instructions: out, warnings }
}

/** Word 多级列表最多 9 级（ilvl 0..8） */
const MAX_HEADING_LEVEL = 9
type CaptionKind = 'table' | 'figure'

/** 图表降级占位段里源码的长度上限：不超过就整段照抄，超了才截断（且必然标注已截断） */
const MERMAID_PLACEHOLDER_LIMIT = 2000

/**
 * 图表降级时的占位文本。嵌入失败时它就是用户在 Word 里看到的"文本形式的图"，
 * 所以源码整段照抄；只有超长才截断，且截断处必然写明已截断、给出真实长度、指出完整源码在工程里。
 * 旧实现固定切前 60 字符：尾部无声丢失、切在半截 token 上，与"以文本形式导出"的提示说的不是一回事。
 */
function mermaidPlaceholder(code: string): string {
  if (code.length <= MERMAID_PLACEHOLDER_LIMIT) return `[Mermaid 图表: ${code}]`
  const head = code.slice(0, MERMAID_PLACEHOLDER_LIMIT)
  const lineEnd = head.lastIndexOf('\n')
  // 优先切在行尾，免得留半截 token；单行过长（超过一半）时只能按长度切
  const kept = lineEnd > MERMAID_PLACEHOLDER_LIMIT / 2 ? head.slice(0, lineEnd) : head
  return `[Mermaid 图表: ${kept}（已截断，源码共 ${code.length} 字符，完整源码见工程文件）]`
}

function paragraph(styleName: string, text: string, listGroupId: number): WriteInstruction {
  return {
    opType: 'InsertParagraph',
    styleName,
    content: { text },
    listGroupId
  }
}

function blockText(block: ContentBlock): string {
  if (block.type === 'formula') return block.latexCode
  if (block.type === 'code') return block.code
  return ''
}

function blockLabel(block: ContentBlock): string {
  return block.type === 'formula' ? '公式块' : '代码块'
}

// ================= 表格形状警告（导出侧的最后一道关） =================

/**
 * 表格形状与声明列数对不上时透出警告。
 *
 * 写入侧（project-service.assertTableShape）只拦新改动，模板、实例 JSON 与老工程
 * 带进来的参差表会一路走到导出；导出侧原来完全不知道表头长度与 cols、各行长度是否一致，
 * 于是形状不对的表被静默写出去。判定仍只有 core 那一份 checkTableShape。
 *
 * 定位优先用表题注（用户在文档里看到的、也是导出后能对上号的就是它），
 * 题注为空时退回节点标题。同一张表的问题合成一条警告，免得参差表刷出一串。
 */
function warnTableShape(node: DocumentNode, block: TableBlock, warnings: string[]): void {
  const issues = checkTableShape(block)
  if (issues.length === 0) return
  const text = issues.map((issue) => tableIssueText(issue, block)).join('；')
  const caption = block.caption.trim()
  const label = caption.length > 0 ? `表格“${caption}”` : `“${node.title}”下的表格`
  // 后果按 writer.renderTable 的口径说：列数取表头、cols 与各行的最大值，短行补空格子
  warnings.push(
    `${label}的形状与列数 ${block.cols} 对不上：${text}。` +
      `导出按表头与最宽的一行为准写表，短行补空格子`
  )
}

/**
 * 把 checkTableShape 的问题说成人话。
 *
 * 它的 reason 是给写入侧排查用的，带 cols、data[0] 这类内部字段名，不适合直接给用户看；
 * 这里按它给的 where 重新组织成"哪张表、什么问题"，判定本身不重复实现。
 * 认不出的 where（core 以后新增检查项）退回原样透出，宁可口径糙一点也不能丢警告。
 */
function tableIssueText(issue: TableShapeIssue, block: TableBlock): string {
  if (issue.where === 'cols') return `列数不合法（${block.cols}）`
  if (issue.where === 'headers') {
    return `表头 ${block.headers.length} 列与列数 ${block.cols} 不一致`
  }
  if (issue.where === 'rows') {
    return `行数写的是 ${block.rows}，比正文的 ${block.data.length} 行少`
  }
  const hit = /^data\[(\d+)\]$/.exec(issue.where)
  if (hit) {
    const i = Number(hit[1])
    return `第 ${i + 1} 行 ${block.data[i]?.length ?? 0} 列与列数 ${block.cols} 不一致`
  }
  return issue.reason
}

// ================= Mermaid 收集（M7 图嵌入链路） =================

export interface MermaidFigureInfo {
  /** 所属节点标题（诊断用） */
  nodeTitle: string
  /** 图题注（可自动编号前缀，原样） */
  caption: string
  /** Mermaid 源码 */
  code: string
}

/**
 * 按 DOCX 序列化顺序收集全部 Mermaid 块（与 serializeToInstructions 的遍历同构：
 * 节点标题 → 内容块 → 递归子节点；仅收集 code 非空的块——即会被写成占位段的块）。
 * 图嵌入链路据此把收集结果与占位段按槽位对齐。
 */
export function collectMermaidFigures(tree: DocumentTree): MermaidFigureInfo[] {
  const out: MermaidFigureInfo[] = []
  const walk = (node: DocumentNode): void => {
    for (const block of node.contentBlocks) {
      if (block.type === 'mermaid' && block.code.length > 0) {
        out.push({ nodeTitle: node.title, caption: block.caption, code: block.code })
      }
    }
    for (const child of node.children) walk(child)
  }
  walk(tree.root)
  return out
}
