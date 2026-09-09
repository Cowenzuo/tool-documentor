/**
 * DocxSerializer：文档树 → 写入指令序列（对齐旧版 docxserializer.cpp 全规则）。
 * - 章节节点标题 → heading.<level> 段落（isSubTitle → subtitle.<depth>）
 * - kText → body；kTable → 表题注段（剥离手写序号）+ 表格；kImage/kMermaid →
 *   占位段 + 图题注段（图名在图下方）；kFormula/kCode → body 占位文本；
 *   列表 → 每项一段 + 独立列表组 id（重新编号）
 * - warnings：样式键缺失时透出（配对软校验的兜底，不静默）
 */
import type { DocumentTree, DocumentNode } from '@documentor/core'
import { stripCaptionNumber } from '@documentor/core'
import type { ContentBlock } from '@documentor/core'
import type { StyleTemplateDef } from '@documentor/templates'
import type { WriteInstruction } from './instructions'

export interface SerializeOptions {
  /** 样式查找函数（默认用 styleDef.styleMap） */
  lookup?: (key: string) => string
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
  for (const child of tree.root.children) {
    serializeNode(child, lookup, out, warnings, () => nextListGroupId++)
  }
  return { instructions: out, warnings }
}

function serializeNode(
  node: DocumentNode,
  lookup: (key: string) => string,
  out: WriteInstruction[],
  warnings: string[],
  nextGroupId: () => number
): void {
  const look = (key: string, context: string): string => {
    const value = lookup(key)
    if (!value) warnings.push(`${context}的样式未生效，已按默认样式输出`)
    return value
  }

  // === 1. 节点标题 ===
  if (!node.isRoot() && node.title.length > 0) {
    if (node.isSubTitle) {
      out.push(
        paragraph(look(`subtitle.${node.subTitleDepth()}`, `“${node.title}”标题`), node.title, 0)
      )
    } else {
      out.push(paragraph(look(`heading.${node.headingLevel}`, `“${node.title}”标题`), node.title, 0))
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
        const listKey =
          block.type === 'orderedList' ? 'list.ordered.1' : 'list.unordered.1'
        const styleName = look(listKey, `“${node.title}”的列表`)
        const groupId = nextGroupId()
        for (const item of block.items) {
          if (item.length === 0) continue
          out.push(paragraph(styleName, item, groupId))
        }
        break
      }
      case 'table': {
        if (block.caption.length > 0) {
          out.push(
            paragraph(
              look('table.caption', `“${node.title}”的表格题注`),
              stripCaptionNumber(block.caption),
              0
            )
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
            bodyStyle: look('table.body', `“${node.title}”的表格`)
          }
        })
        break
      }
      case 'image': {
        if (block.imagePath.length > 0) {
          out.push(paragraph(look('body', `“${node.title}”的图片`), `[图片: ${block.imagePath}]`, 0))
        }
        if (block.caption.length > 0) {
          out.push(
            paragraph(
              look('figure.caption', `“${node.title}”的图片题注`),
              stripCaptionNumber(block.caption),
              0
            )
          )
        }
        break
      }
      case 'mermaid': {
        if (block.code.length > 0) {
          out.push(
            paragraph(
              look('body', `“${node.title}”的流程图`),
              `[Mermaid 图表: ${block.code.slice(0, 60)}]`,
              0
            )
          )
        }
        if (block.caption.length > 0) {
          out.push(
            paragraph(
              look('figure.caption', `“${node.title}”的图片题注`),
              stripCaptionNumber(block.caption),
              0
            )
          )
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
  for (const child of node.children) {
    serializeNode(child, lookup, out, warnings, nextGroupId)
  }
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
