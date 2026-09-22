/**
 * @documentor/templates 对外出口：模板管理器、模板块映射、样式键元数据与模板校验。
 * 这里只做转发。
 *
 * 说明：模板的身份是 uuid（`./identity`），目录扫描在 `./discover`，
 * 引用解析在 `./resolve`；结构模板与样式模板的校验分别是
 * `validateStructureTemplate` 与 `validateStyleTemplate`，样式完整性按
 * `SUPPORTED_STYLE_KEYS`（软件支持的全集）查缺键。
 * 逻辑样式键的**说明**（用途、是否读、回退目标）与对照表行在 `./style-keys`。
 */

export {
  TemplateManager,
  templateBlockToContentBlock,
  isKnownTemplateBlockType
} from './manager'
export {
  KNOWN_BLOCK_TYPES,
  LOCK_TIERS,
  SKELETON_REQUIRED_PARTS,
  parseSkeletonIndex,
  validateStructureTemplate,
  validateStyleTemplate
} from './validate'
export type {
  SkeletonIndex,
  SkeletonStyleInfo,
  StyleValidateOptions,
  ValidationIssue,
  ValidationLevel
} from './validate'
export {
  STYLE_KEY_INFO,
  SUPPORTED_STYLE_KEYS,
  buildStyleMapRows,
  styleKeyInfo,
  unusedSkeletonStyleIds
} from './style-keys'
export type {
  BuildStyleMapRowsInput,
  LogicalStyleKeyInfo,
  StyleKeyGroup,
  StyleMapRow,
  StyleMapRowStatus
} from './style-keys'
export { draftStyleMap } from './style-match'
export type { StyleMapDraft } from './style-match'
/**
 * 模板身份（DESIGN-03）：uuid 是唯一身份，中文名与英文名只作展示。
 * 目录与文件名的推导也收在这一处，别处不许自己拼。
 */
export {
  displayNameOf,
  identityFields,
  isTemplateUuid,
  newTemplateUuid,
  templateFileName,
  templateIdentityOf
} from './identity'
export type { TemplateIdentity } from './identity'
/**
 * 模板目录扫描（DESIGN-03）：目录名是 uuid 才认，清单不再存在。
 */
export { TEMPLATE_SUBDIR, scanTemplateDir } from './discover'
export type {
  DiscoveredTemplate,
  LegacyTemplateDir,
  TemplateKind,
  TemplateScan
} from './discover'
/**
 * 引用解析（DESIGN-03）：按 uuid 找样式，找不到就是悬挂；导出可用集合是全部样式。
 */
export {
  findStructureByUuid,
  findStyleByUuid,
  resolveDefaultStyle,
  stylesForExport
} from './resolve'
export type { StyleResolution } from './resolve'
/**
 * 样式规则（不碰 fs 的那一半）：编辑模式从 `@documentor/templates/style-rules`
 * 直接拿，渲染层实时跑与主进程**同一份**判定。
 */
export { validateStyleMap } from './style-rules'
export type { SkeletonFacts, StyleRulesOptions } from './style-rules'
export type {
  TemplateDef,
  TemplateNodeDef,
  TemplateContentBlockDef,
  StyleTemplateDef,
  CaptionNumberingMode,
  DefaultStyleRef,
  StyleValidationReport,
  LoadDirResult
} from './types'
