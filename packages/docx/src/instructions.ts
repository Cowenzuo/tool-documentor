/**
 * 写入指令（对齐旧版 WriteInstruction）与 XML 转义工具。
 */

export type WriteInstruction =
  | {
      opType: 'InsertParagraph'
      /** DOCX 样式 styleId（如 '49'、'45'），空串 = 无显式样式 */
      styleName: string
      content: { text: string }
      /** >0: 列表组 ID（同组共享克隆 numId）；0: 用样式内置编号 */
      listGroupId: number
    }
  | {
      opType: 'InsertTable'
      content: {
        rows: number
        cols: number
        headers: string[]
        rowsData: string[][]
        headerStyle: string
        bodyStyle: string
      }
    }
  | {
      opType: 'InsertPageBreak'
      content: Record<string, never>
    }

export function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
