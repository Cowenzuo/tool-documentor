/**
 * DocxSerializer：文档树 → 写入指令序列（对齐旧版 docxserializer.cpp 全规则）。
 * - 章节节点标题 → heading.<level> 段落（isSubTitle → subtitle.<depth>）
 * - kText → body；kTable → 表题注段（剥离手写序号）+ 表格；kImage/kMermaid →
 *   占位段 + 图题注段（图名在图下方）；kFormula/kCode → body 占位文本；
 *   列表 → 每项一段 + 独立列表组 id（重新编号）
 * - warnings：样式键缺失时透出（配对软校验的兜底，不静默）
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { DocumentTree, DocumentNode } from '@documentor/core'
import { stripCaptionNumber } from '@documentor/core'
import type { ContentBlock } from '@documentor/core'
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
    return existsSync(abs) ? abs : null
  }

  // ---------- 题注编号状态 ----------
  const cn = styleDef?.captionNumbering
  const modeOf = (kind: CaptionKind): CaptionNumberingMode => cn?.[kind] ?? 'auto'
  const starts = styleDef?.headingStarts ?? []
  const startOf = (level: number): number => starts[level - 1] ?? 1
  const chapterNames = cn?.chapterStyleNames ?? {}
  /** 各标题层级当前编号（下标=层级，1 起） */
  const counters: number[] = []
  /** 题注序号计数：key = `${kind}:${level}` */
  const seqCounters = new Map<string, number>()

  /** 进入标题节点：推进本层计数、重置更深层与相应题注序号（与 Word 多级列表语义一致） */
  const enterHeading = (level: number): void => {
    counters[level] = (counters[level] ?? startOf(level) - 1) + 1
    for (let d = level + 1; d <= MAX_HEADING_LEVEL; d++) counters[d] = startOf(d) - 1
    for (const key of [...seqCounters.keys()]) {
      if (Number(key.split(':')[1]) >= level) seqCounters.delete(key)
    }
  }

  /**
   * 题注（表题/图题）：
   * - auto  → 剥离手写序号，序号由样式多级列表给出
   * - static→ 原样保留（数据侧给出的准确编号）
   * - field → STYLEREF(章节号) + SEQ(本节序号) 域，章节号随标题走且不占用标题列表
   */
  const emitCaption = (
    node: DocumentNode,
    kind: CaptionKind,
    rawCaption: string,
    styleKey: string,
    context: string
  ): void => {
    const style = look(styleKey, context)
    const mode = modeOf(kind)
    if (mode === 'static') {
      out.push(paragraph(style, rawCaption.trim(), 0))
      return
    }
    const title = stripCaptionNumber(rawCaption)
    if (mode === 'auto') {
      out.push(paragraph(style, title, 0))
      return
    }
    const level = Math.max(1, Math.min(MAX_HEADING_LEVEL, node.headingLevel || 1))
    const seqKey = `${kind}:${level}`
    const seqText = String((seqCounters.get(seqKey) ?? 0) + 1)
    seqCounters.set(seqKey, Number(seqText))
    const configured = chapterNames[String(level)]
    out.push({
      opType: 'InsertCaption',
      styleName: style,
      content: {
        label: kind === 'table' ? '表' : '图',
        // 模板未配置（undefined）= 按中文 Word 惯例「标题 N」；显式空串 = 不写域，用算好的章节号文本
        chapterStyleName: configured === undefined ? `标题 ${level}` : configured,
        chapterText: counters.slice(1, level + 1).join('.'),
        seqName: kind === 'table' ? '表' : '图',
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
          if (block.caption.length > 0) {
            emitCaption(
              node,
              'table',
              block.caption,
              'table.caption',
              `“${node.title}”的表格题注`
            )
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
            emitCaption(node, 'figure', block.caption, 'figure.caption', `“${node.title}”的图片题注`)
          }
          break
        }
        case 'mermaid': {
          if (block.code.length > 0) {
            out.push(
              paragraph(
                figureStyle(`“${node.title}”的流程图`),
                `[Mermaid 图表: ${block.code.slice(0, 60)}]`,
                0
              )
            )
          }
          if (block.caption.length > 0) {
            emitCaption(node, 'figure', block.caption, 'figure.caption', `“${node.title}”的图片题注`)
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
