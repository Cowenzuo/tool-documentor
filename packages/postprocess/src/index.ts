/**
 * @documentor/postprocess — Documentor DOCX 后处理（M7 图嵌入链路）。
 *
 * 分层（上游 mmd2vsdx 产出 VSDX 字节，本包只做 docx/VSDX 装配）：
 *   - makeVisioOle / buildCompoundFile / parseCompoundFile：OLE CF 容器（无第三方依赖）；
 *   - embedVsdxIntoDocx:占位段 → w:object(OLE，预览可选) 嵌入,rels/Content_Types 闭合。
 * 预览图（2026-09 修订，见 docs/WORD处理经验/06 与 07）：**本包自产**。
 *   调用方给了 EMF 就按自洽式校正后使用，没给就用内置模板自产一张带示意文字的件；
 *   预览图是 Word 嵌入才需要的产物，且与对象框/画布强相关，所以归本包，不归上游。
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
export { vsdxContentBbox, vsdxPageSize, patchVsdxPageSize, stripVsdxThumbnail } from './vsdx'
export type { VsdxBbox } from './vsdx'
export {
  readPreviewMetrics,
  expectedDeclaredIn,
  checkPreviewConsistency,
  normalizePreviewEmf,
  makePreviewEmf,
  previewGeometry,
  declaredEqualsFrame,
  previewDpiOutOfBand,
  PREVIEW_DPI_WARN_MIN,
  PREVIEW_DPI_WARN_MAX,
  PREVIEW_REF_DPI,
  PREVIEW_LOGICAL_DPI
} from './preview'
export type { PreviewMetrics } from './preview'
