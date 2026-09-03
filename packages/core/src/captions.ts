/**
 * 题注文本处理。
 * 编号由 Word 样式（numbering.xml）自动生成，文本中手写序号必须剥离，否则双重编号。
 * 详细规则见规格 04 §5 与 05；M4 阶段对照旧版 serializer 实测后精调。
 */

const CAPTION_NUMBER_PREFIX = /^(表|图)[ \t　]*\d+([-.]\d+)*[ \t　]*/u

/**
 * 剥离题注文本的"表N / 图N"手写前缀（对齐旧版：先 trim 两端；支持复合编号"图2-1"，
 * 含中文/半角/全角空格）。例如 "表1 引用文档" → "引用文档"；" 图2　系统组成 " → "系统组成"。
 */
export function stripCaptionNumber(text: string): string {
  return text.trim().replace(CAPTION_NUMBER_PREFIX, '')
}
