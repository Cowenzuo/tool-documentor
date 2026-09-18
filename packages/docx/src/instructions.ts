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
        /** 显式纵向跨度：{ 列号: [[起始行, 跨几行], ...] }（优先于下面的兼容开关） */
        rowSpans?: Record<string, Array<[number, number]>>
        /** 兼容开关：同列连续相同内容自动合并（老数据） */
        mergeVertical: boolean
      }
    }
  | {
      opType: 'InsertCaption'
      /** 题注段落样式 styleId（如 capT / capF） */
      styleName: string
      content: {
        /** 标签文字（'表' / '图'），写在域前 */
        label: string
        /** 章节号：STYLEREF 目标样式名（空 = 直接写 chapterText） */
        chapterStyleName: string
        /** 章节号缓存值（如 '4.1.1'） */
        chapterText: string
        /** 序号：SEQ 名称（'表' / '图'） */
        seqName: string
        /** SEQ 重启层级（1..9，对应标题层级） */
        seqRestartLevel: number
        /** 序号缓存值（如 '1'） */
        seqText: string
        /** 题注标题（编号后的文字） */
        title: string
      }
    }
  | {
      opType: 'InsertPageBreak'
      content: Record<string, never>
    }

/**
 * XML 1.0 允许的字符以外的字符一律剔除（制表/换行/回车保留）。
 * 控制字符（\u0000-\u001F 里除 \t\n\r 之外的部分，含 ESC）原样写进 XML 会让
 * 整份 document.xml 非良构，Word 直接报"内容有问题"打不开，所以必须在写入前清掉。
 * 用 u 标志的字符类可以顺带处理落单的代理项。
 */
const XML_ILLEGAL = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu

export function stripIllegalXmlChars(text: string): string {
  return text.replace(XML_ILLEGAL, '')
}

export function escapeXmlText(text: string): string {
  return stripIllegalXmlChars(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function escapeXmlAttr(value: string): string {
  return stripIllegalXmlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
