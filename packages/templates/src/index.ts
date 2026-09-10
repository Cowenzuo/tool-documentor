/**
 * @documentor/templates 对外出口：模板管理器、模板块映射与样式键推导。
 * 这里只做转发。
 */

export { TemplateManager, templateBlockToContentBlock, requiredStyleKeys } from './manager'
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
