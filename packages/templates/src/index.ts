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
  parseSkeletonIndex,
  requiredStyleKeys,
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
