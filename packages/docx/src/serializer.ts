/**
 * DocxSerializer：文档树 → 写入指令序列（对齐旧版 docxserializer.cpp 全规则）。
 * - 章节节点标题 → heading.<level> 段落（isSubTitle → subtitle.<depth>）
 * - kText → body；kTable → 表题注段（剥离手写序号）+ 表格；kImage/kMermaid →
 *   占位段 + 图题注段（图名在图下方）；kFormula/kCode → body 占位文本；
 *   列表 → 每项一段 + 独立列表组 id（重新编号）
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

export function serializeToInstructions(
  tree: DocumentTree,
  styleDef: StyleTemplateDef | null,
  options?: SerializeOptions
): WriteInstruction[] {
  const out: WriteInstruction[] = []
  if (!tree) return out
  let nextListGroupId = 1
  const lookup = (key: string): string => {
    if (options?.lookup) return options.lookup(key)
    return styleDef ? (styleDef.styleMap[key] ?? '') : ''
  }
  for (const child of tree.root.children) {
    serializeNode(child, lookup, out, () => nextListGroupId++)
  }
  return out
}

function serializeNode(
  node: DocumentNode,
  lookup: (key: string) => string,
  out: WriteInstruction[],
  nextGroupId: () => number
): void {
  // === 1. 节点标题 ===
  if (!node.isRoot() && node.title.length > 0) {
    if (node.isSubTitle) {
      out.push(paragraph(lookup(`subtitle.${node.subTitleDepth()}`), node.title, 0))
    } else {
      out.push(paragraph(lookup(`heading.${node.headingLevel}`), node.title, 0))
    }
  }

  // === 2. 内容块 ===
  for (const block of node.contentBlocks) {
    switch (block.type) {
      case 'text': {
        if (block.content.length > 0) {
          out.push(paragraph(lookup('body'), block.content, 0))
        }
        break
      }
      case 'orderedList':
      case 'unorderedList': {
        const listKey =
          block.type === 'orderedList' ? 'list.ordered.1' : 'list.unordered.1'
        const styleName = lookup(listKey)
        const groupId = nextGroupId()
        for (const item of block.items) {
          if (item.length === 0) continue
          out.push(paragraph(styleName, item, groupId))
        }
        break
      }
      case 'table': {
        if (block.caption.length > 0) {
          out.push(paragraph(lookup('table.caption'), stripCaptionNumber(block.caption), 0))
        }
        out.push({
          opType: 'InsertTable',
          content: {
            rows: block.rows,
            cols: block.cols,
            headers: [...block.headers],
            rowsData: block.data.map((row) => [...row]),
            headerStyle: lookup('table.header'),
            bodyStyle: lookup('table.body')
          }
        })
        break
      }
      case 'image': {
        if (block.imagePath.length > 0) {
          out.push(paragraph(lookup('body'), `[图片: ${block.imagePath}]`, 0))
        }
        if (block.caption.length > 0) {
          out.push(paragraph(lookup('figure.caption'), stripCaptionNumber(block.caption), 0))
        }
        break
      }
      case 'mermaid': {
        if (block.code.length > 0) {
          out.push(
            paragraph(lookup('body'), `[Mermaid 图表: ${block.code.slice(0, 60)}]`, 0)
          )
        }
        if (block.caption.length > 0) {
          out.push(paragraph(lookup('figure.caption'), stripCaptionNumber(block.caption), 0))
        }
        break
      }
      case 'formula':
      case 'code': {
        const text = blockText(block)
        out.push(paragraph(lookup('body'), text, 0))
        break
      }
    }
  }

  // === 3. 递归子节点 ===
  for (const child of node.children) {
    serializeNode(child, lookup, out, nextGroupId)
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
