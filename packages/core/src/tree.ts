import { cloneBlock, type ContentBlock } from './blocks'
import { nextNodeId } from './idgen'

/**
 * 文档树节点（对齐旧版 DocumentNode 语义）。
 * headingLevel: 0=根节点, 1..N=标题级别
 */
export class DocumentNode {
  id: string
  parent: DocumentNode | null = null
  children: DocumentNode[] = []
  contentBlocks: ContentBlock[] = []

  headingLevel: number
  title = ''
  description = ''
  copyable = false
  deletable = false
  allowContentBlocks = true
  isSubTitle = false
  /** 编号风格: 'numeric' | 'alpha' | 'alphabetic'（其它视为 numeric） */
  subTitleStyle = 'numeric'
  subTitleAutoNumber = true
  /** 复制组标识，同组节点共享 */
  copyGroupId = ''
  /** 允许的子节点标题级别（字符串数组），空 = 不限制（对齐 db 存储形态） */
  allowedChildLevels: string[] = []

  constructor(headingLevel = 1, id?: string) {
    this.headingLevel = headingLevel
    this.id = id ?? nextNodeId()
  }

  isRoot(): boolean {
    return this.headingLevel === 0
  }

  // ================= 子节点 =================

  /**
   * 追加子节点。校验（与旧版一致）：
   * 1) SubTitle 只能挂 SubTitle / 普通标题可挂 SubTitle 与普通标题，
   *    但普通标题不能挂在 SubTitle 下；
   * 2) 子节点级别必须在 allowedChildLevels 内（非 SubTitle 且白名单非空时）。
   * 校验失败返回 false（不改变结构）。
   */
  addChild(child: DocumentNode): boolean {
    if (!child || child === this) return false
    if (!this.canAccept(child)) return false

    if (child.parent) {
      child.parent.removeChild(child)
    }
    child.parent = this
    this.children.push(child)
    return true
  }

  /** 在指定位置插入子节点（校验规则同 addChild） */
  insertChildAt(index: number, child: DocumentNode): boolean {
    if (!child || child === this) return false
    if (!this.canAccept(child)) return false

    if (child.parent) {
      child.parent.removeChild(child)
    }
    child.parent = this
    const at = Math.max(0, Math.min(index, this.children.length))
    this.children.splice(at, 0, child)
    return true
  }

  private canAccept(child: DocumentNode): boolean {
    if (this.isSubTitle) {
      if (!child.isSubTitle) return false
    } else if (child.isSubTitle) {
      // 普通标题下允许 SubTitle
    }
    if (!this.allowedChildLevels.length || child.isSubTitle) return true
    return this.allowedChildLevels.includes(String(child.headingLevel))
  }

  removeChild(child: DocumentNode): boolean {
    const idx = this.children.indexOf(child)
    if (idx < 0) return false
    this.children.splice(idx, 1)
    child.parent = null
    return true
  }

  removeChildAt(index: number): DocumentNode | null {
    const child = this.children[index]
    if (!child) return null
    child.parent = null
    this.children.splice(index, 1)
    return child
  }

  moveChild(fromIndex: number, toIndex: number): void {
    if (
      fromIndex < 0 ||
      fromIndex >= this.children.length ||
      toIndex < 0 ||
      toIndex >= this.children.length ||
      fromIndex === toIndex
    ) {
      return
    }
    const [node] = this.children.splice(fromIndex, 1)
    if (!node) return
    this.children.splice(toIndex, 0, node)
  }

  // ================= 内容块 =================

  addContentBlock(block: ContentBlock): void {
    this.contentBlocks.push(block)
  }

  insertContentBlock(index: number, block: ContentBlock): void {
    const at = Math.max(0, Math.min(index, this.contentBlocks.length))
    this.contentBlocks.splice(at, 0, block)
  }

  replaceContentBlock(index: number, block: ContentBlock): boolean {
    if (index < 0 || index >= this.contentBlocks.length) return false
    this.contentBlocks[index] = block
    return true
  }

  removeContentBlockAt(index: number): boolean {
    if (index < 0 || index >= this.contentBlocks.length) return false
    this.contentBlocks.splice(index, 1)
    return true
  }

  swapContentBlocks(i: number, j: number): void {
    if (
      i >= 0 &&
      i < this.contentBlocks.length &&
      j >= 0 &&
      j < this.contentBlocks.length
    ) {
      const tmp = this.contentBlocks[i]
      if (!tmp) return
      this.contentBlocks[i] = this.contentBlocks[j]!
      this.contentBlocks[j] = tmp
    }
  }

  // ================= 派生信息 =================

  /** 是否为 Sub Title 及嵌套深度（非 SubTitle 返回 0） */
  subTitleDepth(): number {
    if (!this.isSubTitle) return 0
    let depth = 1
    let cur: DocumentNode | null = this.parent
    while (cur) {
      if (cur.isSubTitle) depth += 1
      cur = cur.parent
    }
    return depth
  }

  /** Sub Title 编号标签链，如 ['1','a']（numeric/alpha 风格；同级 SubTitle 内计数） */
  subTitleNumbering(): string[] {
    if (!this.isSubTitle) return []
    const labels: string[] = []
    let current: DocumentNode | null = this
    while (current && current.parent) {
      const holder: DocumentNode = current.parent
      let index = -1
      let count = 0
      for (const child of holder.children) {
        if (!child.isSubTitle) continue
        if (child === current) {
          index = count
          break
        }
        count += 1
      }
      if (index < 0) break
      const value = index + 1
      // 与旧版一致：整条链的编号风格以当前节点自身样式判定
      const style = this.subTitleStyle
      let label: string
      if (style === 'alpha' || style === 'alphabetic') {
        label = toAlpha(value)
      } else {
        label = String(value)
      }
      labels.unshift(label)
      current = holder
    }
    if (labels.length === 0) return []
    return labels
  }

  /** 同父下同 copyGroupId 的节点数（含自身；无组返回 1） */
  copyGroupCount(): number {
    if (!this.copyGroupId || !this.parent) return 1
    let count = 0
    for (const sibling of this.parent.children) {
      if (sibling.copyGroupId === this.copyGroupId) count += 1
    }
    return count
  }

  /**
   * 深拷贝整棵子树（parent=null）。
   * 与旧版一致：新 id；copyable=false、deletable=true（克隆体不可再复制、可删除）。
   */
  deepClone(): DocumentNode {
    const clone = new DocumentNode(this.headingLevel)
    clone.title = this.title
    clone.description = this.description
    clone.copyable = false
    clone.deletable = true
    clone.allowContentBlocks = this.allowContentBlocks
    clone.isSubTitle = this.isSubTitle
    clone.subTitleStyle = this.subTitleStyle
    clone.subTitleAutoNumber = this.subTitleAutoNumber
    clone.allowedChildLevels = [...this.allowedChildLevels]
    clone.copyGroupId = this.copyGroupId
    for (const child of this.children) {
      // 递归克隆中子树内部校验通常通过；失败（极端模板）则跳过该分支
      clone.addChild(child.deepClone())
    }
    for (const block of this.contentBlocks) {
      clone.addContentBlock(cloneBlock(block))
    }
    return clone
  }
}

function toAlpha(value: number): string {
  let letters = ''
  let v = value
  while (v > 0) {
    v -= 1
    letters = String.fromCharCode(97 + (v % 26)) + letters
    v = Math.floor(v / 26)
  }
  return letters
}

/** 文档树容器 */
export class DocumentTree {
  root: DocumentNode

  constructor(root: DocumentNode) {
    this.root = root
  }

  /** 按 id 查找（含根），未找到返回 null */
  nodeById(id: string): DocumentNode | null {
    let found: DocumentNode | null = null
    this.traverse((node) => {
      if (!found && node.id === id) found = node
    })
    return found
  }

  /** 深度优先遍历（先父后子） */
  traverse(visitor: (node: DocumentNode, depth: number) => void): void {
    this.traverseRecursive(this.root, 0, visitor)
  }

  private traverseRecursive(
    node: DocumentNode,
    depth: number,
    visitor: (node: DocumentNode, depth: number) => void
  ): void {
    visitor(node, depth)
    for (const child of node.children) {
      this.traverseRecursive(child, depth + 1, visitor)
    }
  }

  /** 收集全部节点 id（用于计数器播种） */
  collectIds(): string[] {
    const ids: string[] = []
    this.traverse((n) => ids.push(n.id))
    return ids
  }
}
