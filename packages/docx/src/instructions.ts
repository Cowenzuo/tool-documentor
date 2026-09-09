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
      opType: 'InsertImage'
      content: {
        /** 图片文件绝对路径（由序列化器按工程目录解析） */
        srcPath: string
        /** 图片所在段落样式（figure 键；缺省用样式表 body） */
        styleName: string
      }
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
        /** 纵向自动合并（同列连续相同内容） */
        mergeVertical: boolean
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
