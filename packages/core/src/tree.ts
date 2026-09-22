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
  /** 排版：块集合、顺序、类型能不能动；关掉后只能改各块的内容（PLAN-13 第 1.1 节） */
  allowLayoutEdit = true
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
   * 深拷贝整棵子树（parent=null）：**原样复制**。
   * 新 id，其余状态一律照抄——四个权限开关、编组、内容，块上的档位也跟着来。
   * 复制出来的是"同一个槽位的另一份"，不是另一种东西；要把它扔掉，走的是它自己的 `deletable`。
   */
  deepClone(): DocumentNode {
    const clone = new DocumentNode(this.headingLevel)
    clone.title = this.title
    clone.description = this.description
    clone.copyable = this.copyable
    clone.deletable = this.deletable
    clone.allowContentBlocks = this.allowContentBlocks
    clone.allowLayoutEdit = this.allowLayoutEdit
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

  /**
   * 结构快照：与 deepClone 的区别是**保真**——id 与 parent 原样留着（deepClone 会发新 id、
   * 挂到别的父节点下），其余状态字段两边都是照抄。
   * 撤销与重做拿它存档，所以 id 必须留着：写回时靠 id 找回落点。
   */
  snapshot(): DocumentNode {
    const copy = new DocumentNode(this.headingLevel, this.id)
    copy.title = this.title
    copy.description = this.description
    copy.copyable = this.copyable
    copy.deletable = this.deletable
    copy.allowContentBlocks = this.allowContentBlocks
    copy.allowLayoutEdit = this.allowLayoutEdit
    copy.isSubTitle = this.isSubTitle
    copy.subTitleStyle = this.subTitleStyle
    copy.subTitleAutoNumber = this.subTitleAutoNumber
    copy.allowedChildLevels = [...this.allowedChildLevels]
    copy.copyGroupId = this.copyGroupId
    copy.contentBlocks = this.contentBlocks.map((block) => cloneBlock(block))
    copy.children = this.children.map((child) => {
      const childCopy = child.snapshot()
      childCopy.parent = copy
      return childCopy
    })
    return copy
  }

  /**
   * 用快照恢复本节点的状态（id 与 parent 保持本节点的）。
   * 直接替换 children 与 contentBlocks，不走 addChild 那套校验：快照里的状态当初就是合法的。
   */
  restoreFrom(snapshot: DocumentNode): void {
    this.headingLevel = snapshot.headingLevel
    this.title = snapshot.title
    this.description = snapshot.description
    this.copyable = snapshot.copyable
    this.deletable = snapshot.deletable
    this.allowContentBlocks = snapshot.allowContentBlocks
    this.allowLayoutEdit = snapshot.allowLayoutEdit
    this.isSubTitle = snapshot.isSubTitle
    this.subTitleStyle = snapshot.subTitleStyle
    this.subTitleAutoNumber = snapshot.subTitleAutoNumber
    this.allowedChildLevels = [...snapshot.allowedChildLevels]
    this.copyGroupId = snapshot.copyGroupId
    this.contentBlocks = snapshot.contentBlocks.map((block) => cloneBlock(block))
    this.children = snapshot.children.map((child) => {
      const childCopy = child.snapshot()
      childCopy.parent = this
      return childCopy
    })
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
