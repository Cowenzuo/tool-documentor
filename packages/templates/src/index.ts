/**
 * @documentor/templates 对外出口：模板管理器、模板块映射、样式键推导与模板校验。
 * 这里只做转发。
 *
 * 说明：`requiredStyleKeys` 自批次 0（PLAN-11）起由 `./validate` 提供——它与
 * `check-templates.cjs` 同一套规则，且对结构 JSON 原文、`TemplateDef`、裸节点定义都认。
 * `manager.ts` 里那份同名实现仍在（供 `TemplateManager` 内部使用，行为未变）。
 * 逻辑样式键的**说明**（用途、是否读、回退目标）与对照表行在 `./style-keys`（批次 3）。
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
  requiredStyleKeys,
  styleFactsOfStructure,
  styleFactsOfStructures,
  styleTemplateKeys,
  validateStructureTemplate,
  validateStyleTemplate,
  validateTemplateDir
} from './validate'
export type {
  SkeletonIndex,
  SkeletonStyleInfo,
  StructureValidateOptions,
  StyleValidateOptions,
  TemplateDirEntry,
  TemplateDirValidation,
  ValidationIssue,
  ValidationLevel
} from './validate'
export {
  STYLE_KEY_INFO,
  buildStyleMapRows,
  styleKeyInfo,
  unusedSkeletonStyleIds
} from './style-keys'
export type {
  BuildStyleMapRowsInput,
  LogicalStyleKeyInfo,
  StyleKeyGroup,
  StyleKeyRequirement,
  StyleMapRow,
  StyleMapRowStatus
} from './style-keys'
export { draftStyleMap } from './style-match'
export type { StyleMapDraft } from './style-match'
/**
 * 模板身份（PLAN-12）：uuid 是唯一身份，中文名与英文名只作展示。
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
 * 模板目录扫描（PLAN-12）：目录名是 uuid 才认，清单不再存在。
 * 先与新口径并存，等加载器切过来之后再删清单那一套。
 */
export { TEMPLATE_SUBDIR, scanTemplateDir } from './discover'
export type {
  DiscoveredTemplate,
  LegacyTemplateDir,
  TemplateKind,
  TemplateScan
} from './discover'
/**
 * 引用解析（PLAN-12）：按 uuid 找样式，找不到就是悬挂；导出可用集合是全部样式。
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
export type {
  SkeletonFacts,
  StyleCaptionFact,
  StyleRulesOptions,
  StyleStructureFacts
} from './style-rules'
export type {
  TemplateDef,
  TemplateNodeDef,
  TemplateContentBlockDef,
  StyleTemplateDef,
  CaptionNumberingMode,
  StyleCandidate,
  StyleValidationReport,
  LoadDirResult
} from './types'
