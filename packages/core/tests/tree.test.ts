/** tree.test.ts — 文档树节点增删改查与遍历的单测。 */

import { beforeEach, describe, expect, it } from 'vitest'
import { resetIdCounterForTest } from '../src/idgen'
import { DocumentNode, DocumentTree } from '../src/tree'
import type { ContentBlock } from '../src/blocks'

beforeEach(() => {
  resetIdCounterForTest()
})

describe('DocumentNode 基础', () => {
  it('id 自增数字字符串、isRoot 语义', () => {
    const root = new DocumentNode(0)
    expect(root.isRoot()).toBe(true)
    const a = new DocumentNode(1)
    expect(a.id).toBe('2')
    expect(a.isRoot()).toBe(false)
  })
})

describe('addChild 校验规则（对齐旧版）', () => {
  function makeParent(levels: string[]): DocumentNode {
    const p = new DocumentNode(1)
    p.allowedChildLevels = levels
    return p
  }

  it('级别白名单外拒收', () => {
    const parent = makeParent(['2'])
    const bad = new DocumentNode(3)
    expect(parent.addChild(bad)).toBe(false)
    expect(parent.children).toHaveLength(0)
    const good = new DocumentNode(2)
    expect(parent.addChild(good)).toBe(true)
    expect(parent.children).toHaveLength(1)
  })

  it('SubTitle 嵌套规则：SubTitle 下不允许普通标题', () => {
    const st = new DocumentNode(2)
    st.isSubTitle = true
    const normal = new DocumentNode(3)
    expect(st.addChild(normal)).toBe(false)
    const st2 = new DocumentNode(3)
    st2.isSubTitle = true
    expect(st.addChild(st2)).toBe(true)
  })

  it('白名单为空不限制（但普通标题仍不可挂 SubTitle 下）', () => {
    const parent = makeParent([])
    const any = new DocumentNode(5)
    expect(parent.addChild(any)).toBe(true)
  })

  it('移动节点到新父自动解除旧关系', () => {
    const p1 = makeParent([])
    const p2 = makeParent([])
    const n = new DocumentNode(1)
    p1.addChild(n)
    p2.addChild(n)
    expect(p1.children).toHaveLength(0)
    expect(p2.children).toHaveLength(1)
    expect(n.parent).toBe(p2)
  })

  it('insertChildAt 带校验并夹取索引', () => {
    const parent = makeParent(['2'])
    const a = new DocumentNode(2)
    const b = new DocumentNode(2)
    const bad = new DocumentNode(9)
    parent.addChild(a)
    parent.insertChildAt(0, b)
    expect(parent.children.map((c) => c.id)).toEqual([b.id, a.id])
    expect(parent.insertChildAt(99, bad)).toBe(false)
  })
})

describe('deepClone（对齐旧版：新 id、copyable=false、deletable=true）', () => {
  it('克隆子树且重置权限', () => {
    const root = new DocumentNode(0)
    const src = new DocumentNode(1)
    src.title = '需求'
    src.copyable = true
    src.deletable = false
    src.allowContentBlocks = false
    src.description = '说明'
    src.allowedChildLevels = ['2']
    src.contentBlocks.push({ type: 'text', content: '正文' })
    const child = new DocumentNode(2)
    child.title = '标识'
    src.addChild(child)
    root.addChild(src)

    const clone = src.deepClone()
    expect(clone.id).not.toBe(src.id)
    expect(clone.title).toBe('需求')
    expect(clone.description).toBe('说明')
    expect(clone.copyable).toBe(false)
    expect(clone.deletable).toBe(true)
    expect(clone.allowContentBlocks).toBe(false)
    expect(clone.allowedChildLevels).toEqual(['2'])
    expect(clone.parent).toBeNull()
    expect(clone.children).toHaveLength(1)
    expect(clone.children[0]!.id).not.toBe(child.id)
    expect(clone.contentBlocks[0]).toEqual({ type: 'text', content: '正文' })
    expect(clone.contentBlocks[0]).not.toBe(src.contentBlocks[0])
  })
})

describe('subTitleNumbering / copyGroupCount', () => {
  function subtitle(parent: DocumentNode, style = 'numeric'): DocumentNode {
    const n = new DocumentNode(2)
    n.isSubTitle = true
    n.subTitleStyle = style
    parent.addChild(n)
    return n
  }

  it('numeric 单层编号', () => {
    const root = new DocumentNode(0)
    const chapter = new DocumentNode(1)
    chapter.allowedChildLevels = []
    root.addChild(chapter)
    const s1 = subtitle(chapter)
    const s2 = subtitle(chapter)
    expect(s1.subTitleNumbering()).toEqual(['1'])
    expect(s2.subTitleNumbering()).toEqual(['2'])
    expect(s1.subTitleDepth()).toBe(1)
  })

  it('alpha 嵌套链编号', () => {
    const root = new DocumentNode(0)
    const chapter = new DocumentNode(1)
    root.addChild(chapter)
    const s1 = subtitle(chapter, 'alpha')
    const sub = subtitle(s1, 'alpha')
    expect(s1.subTitleNumbering()).toEqual(['a'])
    expect(sub.subTitleNumbering()).toEqual(['a', 'a'])
  })

  it('copyGroupCount', () => {
    const parent = new DocumentNode(1)
    const n1 = new DocumentNode(2)
    n1.copyGroupId = 'g1'
    const n2 = new DocumentNode(2)
    n2.copyGroupId = 'g1'
    const n3 = new DocumentNode(2)
    parent.addChild(n1)
    parent.addChild(n2)
    parent.addChild(n3)
    expect(n1.copyGroupCount()).toBe(2)
    expect(n3.copyGroupCount()).toBe(1)
  })
})

describe('DocumentTree', () => {
  it('nodeById 深度优先查找、traverse 顺序', () => {
    const root = new DocumentNode(0)
    const c1 = new DocumentNode(1)
    const c2 = new DocumentNode(1)
    const leaf = new DocumentNode(2)
    root.addChild(c1)
    root.addChild(c2)
    c1.addChild(leaf)
    const tree = new DocumentTree(root)

    expect(tree.nodeById(leaf.id)).toBe(leaf)
    expect(tree.nodeById('not-exist')).toBeNull()

    const order: string[] = []
    tree.traverse((n) => order.push(n.id))
    expect(order).toEqual([root.id, c1.id, leaf.id, c2.id])
    expect(tree.collectIds()).toHaveLength(4)
  })

  it('块操作：增删换插', () => {
    const n = new DocumentNode(1)
    const text: ContentBlock = { type: 'text', content: 'a' }
    const list: ContentBlock = { type: 'unorderedList', items: ['x'] }
    n.addContentBlock(text)
    n.addContentBlock(list)
    n.swapContentBlocks(0, 1)
    expect(n.contentBlocks[0]).toBe(list)
    expect(n.contentBlocks[1]).toBe(text)
    n.insertContentBlock(1, { type: 'text', content: 'mid' })
    expect(n.contentBlocks[1]).toEqual({ type: 'text', content: 'mid' })
    expect(n.removeContentBlockAt(0)).toBe(true)
    expect(n.contentBlocks).toHaveLength(2)
    const code: ContentBlock = { type: 'code', language: 'cpp', code: 'x' }
    expect(n.replaceContentBlock(0, code)).toBe(true)
    expect(n.contentBlocks[0]).toBe(code)
    expect(n.replaceContentBlock(99, code)).toBe(false)
  })
})
