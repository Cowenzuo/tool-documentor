import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetIdCounterForTest } from '../src/idgen'
import { ProjectStore } from '../src/store'
import { DocumentNode, DocumentTree } from '../src/tree'
import type { ContentBlock } from '../src/blocks'

let dir: string
let store: ProjectStore

beforeEach(() => {
  resetIdCounterForTest()
  dir = mkdtempSync(join(tmpdir(), 'doc-core-'))
  store = new ProjectStore()
})

afterEach(() => {
  store.close()
})

function buildSampleTree(): DocumentTree {
  const root = new DocumentNode(0)
  root.title = '软件需求规格说明'
  const chapter = new DocumentNode(1)
  chapter.title = '范围'
  chapter.description = '无'
  chapter.copyable = false
  chapter.deletable = false
  chapter.allowContentBlocks = false
  chapter.allowedChildLevels = ['2']
  root.addChild(chapter)

  const section = new DocumentNode(2)
  section.title = '标识'
  section.description = '参考样例内容块自行修改'
  section.contentBlocks.push({
    type: 'orderedList',
    items: ['软件名称：', '软件标识：', '软件简称：', '软件版本：V']
  })
  chapter.addChild(section)

  const textSection = new DocumentNode(2)
  textSection.title = '系统概述'
  textSection.contentBlocks.push({ type: 'text', content: '本文档描述系统的一般特性。' })
  chapter.addChild(textSection)

  // SubTitle 示例
  const st = new DocumentNode(3)
  st.isSubTitle = true
  st.title = '子标题示例'
  st.subTitleStyle = 'numeric'
  section.addChild(st)

  return new DocumentTree(root)
}

describe('ProjectStore create/save/load 往返', () => {
  it('create 建库写 project 元信息，save/load 结构等价且 id 稳定', () => {
    const dbPath = join(dir, 'project.db')
    store.create(dbPath, '测试工程', '438C-软件设计说明(SDD)')
    expect(existsSync(dbPath)).toBe(true)
    expect(store.projectName()).toBe('测试工程')
    expect(store.templateName()).toBe('438C-软件设计说明(SDD)')

    const tree = buildSampleTree()
    const idsBefore = tree.collectIds()
    store.save(tree)

    // 重新打开（模拟重启）读回
    store.close()
    store.open(dbPath)
    expect(store.projectName()).toBe('测试工程')
    const loaded = store.load()
    expect(loaded.collectIds()).toEqual(idsBefore)

    const root = loaded.root
    expect(root.title).toBe('软件需求规格说明')
    expect(root.headingLevel).toBe(0)
    expect(root.children).toHaveLength(1)
    const chapter = root.children[0]!
    expect(chapter.title).toBe('范围')
    expect(chapter.allowContentBlocks).toBe(false)
    expect(chapter.allowedChildLevels).toEqual(['2'])
    expect(chapter.children).toHaveLength(2)

    const section = chapter.children[0]!
    expect(section.title).toBe('标识')
    expect(section.contentBlocks).toHaveLength(1)
    expect(section.contentBlocks[0]).toEqual({
      type: 'orderedList',
      items: ['软件名称：', '软件标识：', '软件简称：', '软件版本：V']
    })
    const st = section.children[0]!
    expect(st.isSubTitle).toBe(true)
    expect(st.title).toBe('子标题示例')
  })

  it('重复 save 全量重写且块/节点顺序稳定（幂等往返）', () => {
    const dbPath = join(dir, 'project2.db')
    store.create(dbPath, 'p2', 't1')
    const tree = buildSampleTree()
    store.save(tree)

    const snapshot1 = JSON.stringify(store.load().collectIds())
    // 修改一个块再保存
    const textSection = tree.root.children[0]!.children[1]!
    textSection.contentBlocks[0] = {
      type: 'text',
      content: '修改后的正文内容，包含中文与英文 mixed 123'
    }
    store.save(tree)
    const snapshot2 = JSON.stringify(store.load().collectIds())
    expect(snapshot2).toBe(snapshot1)

    // 新增节点 id 与既有不冲突（计数器已播种）
    const chapter = tree.root.children[0]!
    const extra = new DocumentNode(2)
    extra.title = '新增标识'
    extra.contentBlocks.push({ type: 'text', content: '新块' })
    chapter.addChild(extra)
    store.save(tree)
    const loadedIds = store.load().collectIds()
    expect(loadedIds).toHaveLength(6)
    expect(new Set(loadedIds).size).toBe(6)
  })
})

describe('ProjectStore ui_state 与 meta', () => {
  it('saveUiState/loadUiState/loadAllUiState', () => {
    const dbPath = join(dir, 'ui.db')
    store.create(dbPath, 'u', 't')
    store.saveUiState('selected_node', '42')
    store.saveUiState('other', 'x')
    expect(store.loadUiState('selected_node')).toBe('42')
    expect(store.loadUiState('missing', 'def')).toBe('def')
    expect(store.loadAllUiState()).toEqual({ selected_node: '42', other: 'x' })

    store.close()
    store.open(dbPath)
    expect(store.loadUiState('selected_node')).toBe('42')
  })

  it('project 表时间戳为本地 ISO 且 updated_at 随 save 更新', () => {
    const dbPath = join(dir, 'ts.db')
    store.create(dbPath, 'ts', 't')
    const raw = readFileSync(dbPath, 'utf8')
    const iso = /T\d{2}:\d{2}:\d{2}/.test(raw)
    expect(iso).toBe(true)
    store.save(buildSampleTree())
  })
})

describe('sample-project 兼容：打开合成样例工程', () => {
  const fixture = join(
    __dirname,
    '../../../resources/test-fixtures/sample-project'
  )

  it('完整加载样例工程（6 节点/4 块）且内容正确', () => {
    const s = new ProjectStore()
    s.open(join(fixture, 'documentor.db'))
    expect(s.projectName()).toBe('示例工程')
    expect(s.templateName()).toBe('示例文档模板 (Demo)')
    const tree = s.load()

    const nodes: string[] = []
    const blocks: string[] = []
    tree.traverse((n) => {
      nodes.push(`${n.id}|${n.headingLevel}|${n.title}`)
      for (const b of n.contentBlocks) blocks.push(`${n.id}|${b.type}`)
    })
    expect(nodes).toHaveLength(6)
    expect(blocks).toHaveLength(4)

    expect(tree.root.title).toBe('示例工程文档')
    const first = tree.root.children[0]!
    expect(first.title).toBe('范围')
    // 实例 JSON 不承载 allowContentBlocks（默认允许，同旧版 buildInstanceNode 语义）
    expect(first.allowContentBlocks).toBe(true)
    expect(first.children.map((c) => c.title)).toEqual(['标识', '概述'])

    const biaoShi = first.children[0]!
    expect(biaoShi.contentBlocks[0]).toEqual({
      type: 'orderedList',
      items: ['条目一：示例', '条目二：示例', '条目三：示例']
    })

    // 保存到新库后往返一致
    const copyPath = join(dir, 'legacy-copy.db')
    const copy = new ProjectStore()
    copy.create(copyPath, '示例工程', '示例文档模板 (Demo)')
    copy.save(tree)
    copy.close()
    copy.open(copyPath)
    const round = copy.load()
    expect(round.collectIds()).toEqual(tree.collectIds())
    let blockCount = 0
    const tables: Extract<ContentBlock, { type: 'table' }>[] = []
    round.traverse((n) => {
      for (const b of n.contentBlocks) {
        blockCount += 1
        if (b.type === 'table') tables.push(b)
      }
    })
    expect(blockCount).toBe(4)
    const refTable = tables.find((t) => t.caption.includes('示例引用'))
    expect(refTable).toBeDefined()
    expect(refTable!.headers).toContain('序号')
    expect(refTable!.data[0]![1]).toBe('DEMO-001')
    copy.close()
    s.close()
  })
})
