/**
 * @documentor/core 对外出口：内容块模型、文档树、SQLite 工程存储、题注与时间工具。
 * 这里只做转发，具体实现留在各自文件里。
 */

export {
  BLOCK_TYPE_NAMES,
  blockTypeIndex,
  blockTypeName,
  createBlock,
  propsOf,
  blockFromDb,
  cloneBlock
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
  BlockPropsMap
} from './blocks'
export { DocumentNode, DocumentTree } from './tree'
export { ProjectStore } from './store'
export type { ProjectMeta } from './store'
export { nextNodeId, seedIdCounter, resetIdCounterForTest } from './idgen'
export { stripCaptionNumber } from './captions'
export {
  resolveTableMerges,
  computeVerticalMerges,
  countVerticalMerges,
  inferRowSpansFromData
} from './table-merge'
export type { TableMergeCell, TableSpanSource } from './table-merge'
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
export type {
  InstanceFile,
  InstanceNodeJson,
  InstanceBlockJson
} from './instance'
