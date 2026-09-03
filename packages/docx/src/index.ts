export { serializeToInstructions } from './serializer'
export type { SerializeOptions } from './serializer'
export { writeDocx } from './writer'
export type { WriteDocxResult } from './writer'
export type { WriteInstruction } from './instructions'
export { escapeXmlText, escapeXmlAttr } from './instructions'

import type { DocumentTree } from '@documentor/core'
import type { StyleTemplateDef } from '@documentor/templates'
import type { WriteInstruction } from './instructions'
import { serializeToInstructions } from './serializer'
import { writeDocx } from './writer'

/** 一键导出：树 + 样式模板 → .docx 文件 */
export async function exportTreeToDocx(
  tree: DocumentTree,
  styleDef: StyleTemplateDef,
  outputPath: string
): Promise<{ instructions: WriteInstruction[]; outputPath: string; clonedGroups: number }> {
  const instructions = serializeToInstructions(tree, styleDef)
  const result = await writeDocx(instructions, styleDef, outputPath)
  return { instructions, ...result }
}
