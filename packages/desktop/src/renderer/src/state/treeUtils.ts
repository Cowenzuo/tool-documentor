/**
 * NodeDto 不可变树操作（renderer 本地镜像使用）。
 */
import type { NodeDto } from '../../../shared/project'
import type { ContentBlock } from '@documentor/core/blocks'

export function findNode(root: NodeDto | null, id: string): NodeDto | null {
  if (!root) return null
  if (root.id === id) return root
  for (const child of root.children) {
    const hit = findNode(child, id)
    if (hit) return hit
  }
  return null
}

export interface ParentSlot {
  parent: NodeDto
  index: number
}

export function findParent(root: NodeDto | null, id: string): ParentSlot | null {
  if (!root) return null
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i]!
    if (child.id === id) return { parent: root, index: i }
    const hit = findParent(child, id)
    if (hit) return hit
  }
  return null
}

/** 更新节点任意字段（浅字段），返回新根 */
export function updateNode(
  root: NodeDto,
  id: string,
  patch: Partial<Omit<NodeDto, 'children' | 'contentBlocks'>>
): NodeDto {
  if (root.id === id) return { ...root, ...patch }
  return { ...root, children: root.children.map((c) => updateNode(c, id, patch)) }
}

/** 移除节点（非根），返回新根或 null（根） */
export function removeNode(root: NodeDto, id: string): NodeDto | null {
  if (root.id === id) return null
  const children: NodeDto[] = []
  let removed = false
  for (const child of root.children) {
    if (!removed && child.id === id) {
      removed = true
      continue
    }
    children.push(child)
  }
  if (removed) return { ...root, children }
  return { ...root, children: root.children.map((c) => removeNode(c, id) ?? c) }
}

/** 在指定父的 index 处插入节点（对深拷贝子树） */
export function insertNode(
  root: NodeDto,
  parentId: string,
  index: number,
  node: NodeDto
): NodeDto {
  if (root.id === parentId) {
    const children = [...root.children]
    children.splice(Math.max(0, Math.min(index, children.length)), 0, node)
    return { ...root, children }
  }
  return { ...root, children: root.children.map((c) => insertNode(c, parentId, index, node)) }
}

export function updateBlock(
  root: NodeDto,
  nodeId: string,
  index: number,
  block: ContentBlock
): NodeDto {
  return updateNodeListField(root, nodeId, (blocks) => {
    const next = [...blocks]
    if (index >= 0 && index < next.length) next[index] = block
    return next
  })
}

export function addBlock(
  root: NodeDto,
  nodeId: string,
  block: ContentBlock,
  index?: number
): NodeDto {
  return updateNodeListField(root, nodeId, (blocks) => {
    if (typeof index !== 'number') return [...blocks, block]
    const next = [...blocks]
    next.splice(Math.max(0, Math.min(index, next.length)), 0, block)
    return next
  })
}

export function removeBlockAt(root: NodeDto, nodeId: string, index: number): NodeDto {
  return updateNodeListField(root, nodeId, (blocks) => blocks.filter((_, i) => i !== index))
}

export function moveBlockIn(
  root: NodeDto,
  nodeId: string,
  from: number,
  to: number
): NodeDto {
  return updateNodeListField(root, nodeId, (blocks) => {
    const next = [...blocks]
    if (from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) {
      return next
    }
    const [item] = next.splice(from, 1)
    if (!item) return next
    next.splice(to, 0, item)
    return next
  })
}

function updateNodeListField(
  root: NodeDto,
  nodeId: string,
  fn: (blocks: ContentBlock[]) => ContentBlock[]
): NodeDto {
  if (root.id === nodeId) return { ...root, contentBlocks: fn(root.contentBlocks) }
  return {
    ...root,
    children: root.children.map((c) => updateNodeListField(c, nodeId, fn))
  }
}

/** 树统计 */
export function countTree(root: NodeDto): { nodes: number; blocks: number } {
  let nodes = 1
  let blocks = root.contentBlocks.length
  for (const child of root.children) {
    const sub = countTree(child)
    nodes += sub.nodes
    blocks += sub.blocks
  }
  return { nodes, blocks }
}

/** 扁平化全部节点 id（恢复选中用） */
export function collectIds(root: NodeDto | null): string[] {
  if (!root) return []
  const out: string[] = [root.id]
  for (const child of root.children) {
    out.push(...collectIds(child))
  }
  return out
}
