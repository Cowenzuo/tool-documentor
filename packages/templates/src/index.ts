/**
 * @documentor/templates 对外出口：模板管理器、模板块映射、样式键推导与模板校验。
 * 这里只做转发。
 *
 * 说明：`requiredStyleKeys` 自批次 0（PLAN-11）起由 `./validate` 提供——它与
 * `check-templates.cjs` 同一套规则，且对结构 JSON 原文、`TemplateDef`、裸节点定义都认。
 * `manager.ts` 里那份同名实现仍在（供 `TemplateManager` 内部使用，行为未变）。
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
  validateStructureTemplate,
  validateStyleTemplate
} from './validate'
export type {
  SkeletonIndex,
  SkeletonStyleInfo,
  StructureValidateOptions,
  StyleValidateOptions,
  ValidationIssue,
  ValidationLevel
} from './validate'
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
