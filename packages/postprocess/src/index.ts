/**
 * @documentor/postprocess — Documentor DOCX 后处理（M7 图嵌入链路）。
 *
 * 分层（上游 mmd2vsdx 产出 VSDX 字节，本包只做 docx/VSDX 装配）：
 *   - makeVisioOle / buildCompoundFile / parseCompoundFile：OLE CF 容器（无第三方依赖）；
 *   - embedVsdxIntoDocx:占位段 → w:object(OLE+预览) 嵌入,rels/Content_Types 闭合。
 * 注：预览图 = 上游转换的附带物（mmd2vsdx 工程产出，同源同风格）；本包/本工程
 *     不再生成预览（旧版 Visio COM/EMF 渲染已移除，避免任何 Word/Visio 实例依赖）。
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
export { vsdxContentBbox, patchVsdxPageSize } from './vsdx'
export type { VsdxBbox } from './vsdx'
