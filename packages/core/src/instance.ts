/**
 * 实例 JSON（交换格式）→ 文档树。
 * 对齐旧版 main.cpp buildInstanceNode 语义：
 * - 节点字段 title/headingLevel/copyable/deletable/nodeType=subTitle(+subTitleStyle)
 * - 块类型：text(content)/orderedList/unorderedList(items)/table(caption,rows,cols,
 *   headers,data)/mermaid(caption + code 取自 content)/heading→文本块
 */
import type { ContentBlock } from './blocks'
import { DocumentNode, DocumentTree } from './tree'

export interface InstanceBlockJson {
  type: string
  content?: string
  caption?: string
  items?: string[]
  rows?: number
  cols?: number
  headers?: string[]
  data?: string[][]
}

export interface InstanceNodeJson {
  title?: string
  headingLevel?: number
  copyable?: boolean
  deletable?: boolean
  nodeType?: string
  subTitleStyle?: string
  contentBlocks?: InstanceBlockJson[]
  children?: InstanceNodeJson[]
}

export interface InstanceFile {
  name?: string
  category?: string
  description?: string
  version?: string
  root: {
    title?: string
    children?: InstanceNodeJson[]
  }
}

export function buildTreeFromInstance(instance: InstanceFile): DocumentTree {
  const root = new DocumentNode(0)
  root.title = instance.root?.title ?? ''
  for (const childJson of instance.root?.children ?? []) {
    const child = buildInstanceNode(childJson)
    root.addChild(child)
  }
  return new DocumentTree(root)
}

function buildInstanceNode(json: InstanceNodeJson): DocumentNode {
  const hLevel = json.headingLevel ?? 1
  const node = new DocumentNode(hLevel)
  node.title = json.title ?? ''
  node.copyable = json.copyable ?? false
  node.deletable = json.deletable ?? false
  if (json.nodeType === 'subTitle') {
    node.isSubTitle = true
    node.subTitleStyle = json.subTitleStyle ?? 'numeric'
  }

  for (const blockJson of json.contentBlocks ?? []) {
    const block = buildInstanceBlock(blockJson)
    if (block) node.addContentBlock(block)
  }
  for (const childJson of json.children ?? []) {
    const child = buildInstanceNode(childJson)
    node.addChild(child)
  }
  return node
}

function buildInstanceBlock(json: InstanceBlockJson): ContentBlock | null {
  switch (json.type) {
    case 'text':
    case 'heading':
      // 实例中的 heading 作为普通文本块处理（与旧版一致）
      return { type: 'text', content: json.content ?? '' }
    case 'orderedList':
      return { type: 'orderedList', items: [...(json.items ?? [])] }
    case 'unorderedList':
      return { type: 'unorderedList', items: [...(json.items ?? [])] }
    case 'table':
      return {
        type: 'table',
        caption: json.caption ?? '',
        rows: json.rows ?? 0,
        cols: json.cols ?? 0,
        headers: [...(json.headers ?? [])],
        data: (json.data ?? []).map((row) => [...row])
      }
    case 'mermaid':
      return { type: 'mermaid', caption: json.caption ?? '', code: json.content ?? '' }
    default:
      return null
  }
}
