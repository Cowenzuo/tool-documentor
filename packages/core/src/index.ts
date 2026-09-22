/**
 * @documentor/core 对外出口：内容块模型、文档树、SQLite 工程存储、题注与时间工具。
 * 这里只做转发，具体实现留在各自文件里。
 */

export {
  BLOCK_TYPE_NAMES,
  blockTypeIndex,
  blockTypeName,
  parseBlockType,
  createBlock,
  propsOf,
  blockFromDb,
  cloneBlock,
  parseBlockLock,
  BLOCK_LOCK_LEVELS
} from './blocks'
export type {
  BlockTypeName,
  ContentBlock,
  TextBlock,
  ImageBlock,
  TableBlock,
  FormulaBlock,
  CodeBlock,
  MermaidBlock,
  OrderedListBlock,
  UnorderedListBlock,
  ListBlock,
  TextBlockProps,
  ImageBlockProps,
  TableBlockProps,
  FormulaBlockProps,
  CodeBlockProps,
  MermaidBlockProps,
  ListBlockProps,
  BlockLockLevel,
  BlockLockProps,
  BlockPropsMap
} from './blocks'
export { DocumentNode, DocumentTree } from './tree'
export { convertBlock, blockLines, blockCaption } from './block-convert'
export type { BlockConversion } from './block-convert'
export { ProjectStore } from './store'
export type { ProjectMeta } from './store'
export { nextNodeId, seedIdCounter, resetIdCounterForTest } from './idgen'
export {
  resolveTableMerges,
  computeVerticalMerges,
  countVerticalMerges,
  clampRowSpans
} from './table-merge'
export type { TableMergeCell, TableSpanSource } from './table-merge'
export { TABLE_MAX_ROWS, TABLE_MAX_COLS, bodyRowCount, checkTableShape } from './table-limits'
export type { TableShapeIssue } from './table-limits'
export { normalizeMermaidSource, isMermaidSourceDirty } from './mermaid-source'
export { localIsoNow, toLocalIso } from './time'
export {
  readAnchor,
  writeAnchor,
  anchorPath,
  dbPathOf,
  projectDirOf,
  ANCHOR_FILE_NAME,
  DEFAULT_DB_FILE
} from './anchor'
export type { ProjectAnchor } from './anchor'
export { buildTreeFromInstance } from './instance'
export {
  HistoryStack,
  HISTORY_COALESCE_MS,
  HISTORY_MAX_STEPS,
  HISTORY_MAX_BYTES
} from './history'
export type {
  HistoryEntry,
  HistoryPushInput,
  HistoryStackOptions,
  HistoryState
} from './history'
export type {
  InstanceFile,
  InstanceNodeJson,
  InstanceBlockJson
} from './instance'
