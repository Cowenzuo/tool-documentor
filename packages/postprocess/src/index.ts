/**
 * @documentor/postprocess — Documentor DOCX 后处理（M7 图嵌入链路）。
 *
 * 分层（上游 mmd2vsdx 产出 VSDX 字节，本包只做 docx/VSDX 装配）：
 *   - makeVisioOle / buildCompoundFile / parseCompoundFile：OLE CF 容器（无第三方依赖）；
 *   - embedVsdxIntoDocx:占位段 → w:object(OLE，预览可选) 嵌入,rels/Content_Types 闭合。
 * 注：预览图由调用方决定给不给。本工程不给——上游不自产预览，Word 里显示对象图标，
 *     这是约定的交付口径（见 DESIGN-07 第 5 节）；本包只是"给了就嵌进去"，不产图也不找图。
 */
export {
  buildCompoundFile,
  parseCompoundFile,
  nowFileTime,
  CFB_SECTOR,
  CFB_MINI,
  CFB_MINI_CUTOFF,
  CFB_DIFAT_ENTRIES
} from './cfb'
export type { CfbBuildOptions } from './cfb'
export {
  makeVisioOle,
  buildCompObj,
  VISIO_CLSID,
  VISIO_PROGID,
  VISIO_APP_NAME,
  VISIO_USER_TYPE,
  OLE01_STREAM,
  OBJINFO_STREAM
} from './ole-streams'
export type { CompObjOptions } from './ole-streams'
export { embedVsdxIntoDocx, docxBodyWidthPt } from './embed'
export type { FigureInput, EmbedVsdxOptions, EmbedVsdxResult } from './embed'
export { vsdxContentBbox, vsdxPageSize, patchVsdxPageSize } from './vsdx'
export type { VsdxBbox } from './vsdx'
