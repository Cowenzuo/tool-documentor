/**
 * @documentor/docx 对外出口：指令序列化、OOXML 打包与图表嵌入链路。
 * 这里只做转发。
 */

export { serializeToInstructions, serializeWithWarnings, collectMermaidFigures } from './serializer'
export type { SerializeOptions, SerializeResult, MermaidFigureInfo } from './serializer'
export { writeDocx } from './writer'
export type { WriteDocxResult } from './writer'
export { attachFiguresToDocx, exportTreeToDocxWithFigures, resolveMmdFacade } from './figure-export'
export type {
  FigurePipelineOptions,
  FigurePipelineStats,
  FigurePipelineResult,
  TreeDocxWithFiguresResult
} from './figure-export'
export type { WriteInstruction } from './instructions'
export { escapeXmlText, escapeXmlAttr } from './instructions'

import type { DocumentTree } from '@documentor/core'
import type { StyleTemplateDef } from '@documentor/templates'
import type { WriteInstruction } from './instructions'
import { serializeWithWarnings } from './serializer'
import { writeDocx } from './writer'

/** 一键导出：树 + 样式模板 → .docx 文件（附带样式缺失警告） */
export async function exportTreeToDocx(
  tree: DocumentTree,
  styleDef: StyleTemplateDef,
  outputPath: string
): Promise<{
  instructions: WriteInstruction[]
  outputPath: string
  clonedGroups: number
  warnings: string[]
}> {
  const { instructions, warnings } = serializeWithWarnings(tree, styleDef)
  const result = await writeDocx(instructions, styleDef, outputPath)
  return { instructions, warnings, ...result }
}
