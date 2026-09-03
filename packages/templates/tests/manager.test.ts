import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resetIdCounterForTest } from '@documentor/core'
import { TemplateManager } from '../src/manager'

const BUILTIN = fileURLToPath(new URL('../../../resources/templates/', import.meta.url))

function createManager(): TemplateManager {
  const mgr = new TemplateManager()
  const result = mgr.loadTemplateDir(BUILTIN)
  return mgr
}

describe('内置模板资产加载（resources/templates/builtin）', () => {
  it('加载 2 结构 + 2 样式（双 key 注册）', () => {
    const mgr = createManager()
    const structures = mgr.listStructures()
    expect(structures).toHaveLength(2)
    expect(structures.map((s) => s.name)).toEqual([
      '438C-软件需求规格说明(SRS)',
      '438C-软件设计说明(SDD)'
    ])
    const styles = mgr.listStyles()
    expect(styles).toHaveLength(2)
    expect(styles.map((s) => s.name)).toEqual([
      '438C-军用软件文档格式',
      '438C-软件设计说明格式'
    ])
    // stylemap 文件 key 可查
    expect(mgr.findStyleTemplate('438c-srs-stylemap')).toBeDefined()
    expect(mgr.findStyleTemplate('438c-sdd-stylemap')).toBeDefined()
    expect(mgr.findStyleTemplate('不存在的样式')).toBeUndefined()
  })

  it('结构模板元信息与样式关联', () => {
    const mgr = createManager()
    const srs = mgr.findStructureByName('438C-软件需求规格说明(SRS)')!
    expect(srs).toBeDefined()
    expect(srs.category).toBe('军用软件文档')
    expect(srs.styleTemplate).toBe('438c-srs-stylemap')
    const style = mgr.styleForStructure(srs)
    expect(style).toBeDefined()
    expect(style!.styleMap['heading.1']).toBe('49')
    expect(style!.styleMap['figure.caption']).toBe('60')
    expect(style!.docxFolder).toBe('438c-srs-style')
    expect(mgr.findStructureById('438c-srs')).toBe(srs)
  })

  it('样式骨架校验：styleMap 引用的 styleId 全部存在于 styles.xml', () => {
    const mgr = createManager()
    for (const style of mgr.listStyles()) {
      const report = mgr.validateStyleTemplate(style)
      expect(report.missing).toEqual([])
      expect(report.valid).toBe(true)
    }
  })
})

describe('结构模板实例化（对齐旧版 cloneNode 语义）', () => {
  it('SRS 模板 → 文档树（41 节点，与旧工程 testproject db 一致）', () => {
    resetIdCounterForTest()
    const mgr = createManager()
    const srs = mgr.findStructureByName('438C-软件需求规格说明(SRS)')!
    const tree = mgr.instantiate(srs)!
    const nodeIds: string[] = []
    tree.traverse((n) => nodeIds.push(n.id))
    // 旧 testproject db 有 41 节点（模板树深拷贝入库的结果），此处必须一致
    expect(nodeIds).toHaveLength(41)

    const root = tree.root
    expect(root.isRoot()).toBe(true)
    expect(root.title).toBe('软件需求规格说明')
    // 顶层 6 章（与旧工程 db 顶层一致）
    expect(root.children.map((c) => c.title)).toEqual([
      '范围',
      '引用文档',
      '需求',
      '合格性规定',
      '需求可追踪性',
      '注释'
    ])

    const scope = root.children[0]!
    expect(scope.allowContentBlocks).toBe(false)
    expect(scope.copyable).toBe(false)
    expect(scope.deletable).toBe(false)
    // allowedChildLevels 由子定义推导
    expect(scope.allowedChildLevels).toEqual(['2'])
    expect(scope.children.map((c) => c.title)).toEqual(['标识', '系统概述', '文档概述'])

    const biaoShi = scope.children[0]!
    expect(biaoShi.contentBlocks).toHaveLength(1)
    expect(biaoShi.contentBlocks[0]).toEqual({
      type: 'orderedList',
      items: ['软件名称：', '软件标识：', '软件简称：', '软件版本：V']
    })

    // 引用文档章节含表格块（表1 引用文档，含表头与首行）
    const refs = root.children[1]!
    const tableBlock = refs.contentBlocks.find((b) => b.type === 'table')
    expect(tableBlock).toBeDefined()
    if (tableBlock && tableBlock.type === 'table') {
      expect(tableBlock.caption).toBe('表1 引用文档')
      expect(tableBlock.rows).toBe(3)
      expect(tableBlock.cols).toBe(6)
      expect(tableBlock.headers[0]).toBe('序号')
      expect(tableBlock.data[0]![1]).toBe('GJB 438C-2021')
    }
  })

  it('实例化产出可完整保存并读回（模板 → db 往返）', () => {
    // 说明：存储往返已在 core 覆盖；这里验证模板树的块类型分布合理
    const mgr = createManager()
    const srs = mgr.findStructureByName('438C-软件需求规格说明(SRS)')!
    const tree = mgr.instantiate(srs)!
    const types = new Map<string, number>()
    tree.traverse((n) => {
      for (const b of n.contentBlocks) {
        types.set(b.type, (types.get(b.type) ?? 0) + 1)
      }
    })
    expect([...types.keys()].sort()).toEqual(
      ['mermaid', 'orderedList', 'table', 'text', 'unorderedList'].sort()
    )
    expect(types.get('table')!).toBeGreaterThanOrEqual(1)
  })
})

describe('用户目录优先与无效目录回退', () => {
  it('同名结构先加载者优先；无效目录跳过不抛错', () => {
    const mgr = new TemplateManager()
    const missing = mgr.loadTemplateDir('Z:/no-such-dir')
    expect(missing.structuresLoaded).toBe(0)
    expect(missing.skipped.length).toBeGreaterThan(0)

    const r1 = mgr.loadTemplateDir(BUILTIN)
    const r2 = mgr.loadTemplateDir(BUILTIN)
    expect(r1.structuresLoaded).toBe(2)
    // 重复加载：全部因重名跳过
    expect(r2.structuresLoaded).toBe(0)
    expect(r2.stylesLoaded).toBe(0)
    expect(r2.skipped.length).toBe(4)
    expect(mgr.listStructures()).toHaveLength(2)
  })
})
