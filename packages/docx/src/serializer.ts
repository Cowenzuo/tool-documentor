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
  /** 样式键缺失明细（如：节点“附录”标题：缺少样式 subtitle.1） */
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
    if (!value) warnings.push(`${context}：缺少样式 ${key}`)
    return value
  }

  // === 1. 节点标题 ===
  if (!node.isRoot() && node.title.length > 0) {
    if (node.isSubTitle) {
      out.push(
        paragraph(look(`subtitle.${node.subTitleDepth()}`, `节点“${node.title}”标题`), node.title, 0)
      )
    } else {
      out.push(paragraph(look(`heading.${node.headingLevel}`, `节点“${node.title}”标题`), node.title, 0))
    }
  }

  // === 2. 内容块 ===
  for (const block of node.contentBlocks) {
    switch (block.type) {
      case 'text': {
        if (block.content.length > 0) {
          out.push(paragraph(look('body', `节点“${node.title}”文本块`), block.content, 0))
        }
        break
      }
      case 'orderedList':
      case 'unorderedList': {
        const listKey =
          block.type === 'orderedList' ? 'list.ordered.1' : 'list.unordered.1'
        const styleName = look(listKey, `节点“${node.title}”列表块`)
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
              look('table.caption', `节点“${node.title}”表题注`),
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
            headerStyle: look('table.header', `节点“${node.title}”表格`),
            bodyStyle: look('table.body', `节点“${node.title}”表格`)
          }
        })
        break
      }
      case 'image': {
        if (block.imagePath.length > 0) {
          out.push(paragraph(look('body', `节点“${node.title}”图片占位`), `[图片: ${block.imagePath}]`, 0))
        }
        if (block.caption.length > 0) {
          out.push(
            paragraph(
              look('figure.caption', `节点“${node.title}”图题注`),
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
              look('body', `节点“${node.title}”Mermaid 占位`),
              `[Mermaid 图表: ${block.code.slice(0, 60)}]`,
              0
            )
          )
        }
        if (block.caption.length > 0) {
          out.push(
            paragraph(
              look('figure.caption', `节点“${node.title}”图题注`),
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
