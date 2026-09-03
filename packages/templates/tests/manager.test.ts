import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resetIdCounterForTest } from '@documentor/core'
import { TemplateManager, requiredStyleKeys } from '../src/manager'

const SAMPLE = fileURLToPath(new URL('../../../resources/test-fixtures/sample-template/', import.meta.url))

function createManager(): TemplateManager {
  const mgr = new TemplateManager()
  mgr.loadTemplateDir(SAMPLE)
  return mgr
}

describe('示例模板资产加载（resources/test-fixtures/sample-template，合成无版权数据）', () => {
  it('加载 1 结构 + 3 样式（双 key 注册）', () => {
    const mgr = createManager()
    const structures = mgr.listStructures()
    expect(structures).toHaveLength(1)
    expect(structures[0]!.name).toBe('示例文档模板 (Demo)')
    const styles = mgr.listStyles()
    expect(styles).toHaveLength(3)
    expect(styles[0]!.name).toBe('示例文档样式')
    // stylemap 文件 key 可查
    expect(mgr.findStyleTemplate('demo-stylemap')).toBeDefined()
    expect(mgr.findStyleTemplate('demo-alt-full-stylemap')).toBeDefined()
    expect(mgr.findStyleTemplate('demo-alt-missing-stylemap')).toBeDefined()
    expect(mgr.findStyleTemplate('不存在的样式')).toBeUndefined()
  })

  it('结构模板元信息与样式关联', () => {
    const mgr = createManager()
    const demo = mgr.findStructureByName('示例文档模板 (Demo)')!
    expect(demo).toBeDefined()
    expect(demo.styleTemplate).toBe('demo-stylemap')
    // 1:N 集合解析
    expect(demo.styleTemplates).toEqual([
      'demo-stylemap',
      'demo-alt-full-stylemap',
      'demo-alt-missing-stylemap'
    ])
    const style = mgr.styleForStructure(demo)
    expect(style).toBeDefined()
    expect(style!.styleMap['heading.1']).toBe('49')
    expect(style!.styleMap['figure.caption']).toBe('60')
    expect(style!.docxFolder).toBe('demo-style')
    expect(mgr.findStructureById('demo')).toBe(demo)
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
  it('示例模板 → 文档树（8 节点，含全部块类型）', () => {
    resetIdCounterForTest()
    const mgr = createManager()
    const demo = mgr.findStructureByName('示例文档模板 (Demo)')!
    const tree = mgr.instantiate(demo)!
    const nodeIds: string[] = []
    tree.traverse((n) => nodeIds.push(n.id))
    expect(nodeIds).toHaveLength(8)

    const root = tree.root
    expect(root.isRoot()).toBe(true)
    expect(root.title).toBe('示例文档')
    expect(root.children.map((c) => c.title)).toEqual(['范围', '引用文档', '需求', '附录'])

    const scope = root.children[0]!
    expect(scope.allowContentBlocks).toBe(false)
    expect(scope.allowedChildLevels).toEqual(['2'])
    expect(scope.children.map((c) => c.title)).toEqual(['标识', '概述'])

    const biaoShi = scope.children[0]!
    expect(biaoShi.contentBlocks).toHaveLength(1)
    expect(biaoShi.contentBlocks[0]).toEqual({
      type: 'orderedList',
      items: ['条目一：示例', '条目二：示例', '条目三：示例']
    })

    // 引用文档章节表格
    const refs = root.children[1]!
    const tableBlock = refs.contentBlocks.find((b) => b.type === 'table')
    expect(tableBlock).toBeDefined()
    if (tableBlock && tableBlock.type === 'table') {
      expect(tableBlock.caption).toBe('表1 示例引用')
      expect(tableBlock.headers[0]).toBe('序号')
      expect(tableBlock.data[0]![1]).toBe('DEMO-001')
    }

    // SubTitle 节点（附录 A）
    const appendix = root.children[3]!
    const sub = appendix.children[0]!
    expect(sub.isSubTitle).toBe(true)
    expect(sub.subTitleStyle).toBe('alpha')
  })

  it('实例化产出块类型分布（7 类）', () => {
    const mgr = createManager()
    const demo = mgr.findStructureByName('示例文档模板 (Demo)')!
    const tree = mgr.instantiate(demo)!
    const types = new Map<string, number>()
    tree.traverse((n) => {
      for (const b of n.contentBlocks) {
        types.set(b.type, (types.get(b.type) ?? 0) + 1)
      }
    })
    expect(
      [...types.keys()].sort()
    ).toEqual(
      ['code', 'formula', 'mermaid', 'orderedList', 'table', 'text', 'unorderedList'].sort()
    )
  })
})

describe('用户目录优先与无效目录回退', () => {
  it('同名结构先加载者优先；无效目录跳过不抛错', () => {
    const mgr = new TemplateManager()
    const missing = mgr.loadTemplateDir('Z:/no-such-dir')
    expect(missing.structuresLoaded).toBe(0)
    expect(missing.skipped.length).toBeGreaterThan(0)

    const r1 = mgr.loadTemplateDir(SAMPLE)
    const r2 = mgr.loadTemplateDir(SAMPLE)
    expect(r1.structuresLoaded).toBe(1)
    expect(r1.stylesLoaded).toBe(3)
    expect(r2.structuresLoaded).toBe(0)
    expect(r2.stylesLoaded).toBe(0)
    expect(r2.skipped.length).toBe(4)
    expect(mgr.listStructures()).toHaveLength(1)
  })
})

describe('结构 × 样式配对（软校验候选）', () => {
  it('requiredStyleKeys 静态推导：包含树所需的全部逻辑键', () => {
    const mgr = createManager()
    const demo = mgr.findStructureByName('示例文档模板 (Demo)')!
    const keys = requiredStyleKeys(demo)
    expect(keys).toEqual(
      [
        'body',
        'figure.caption',
        'heading.1',
        'heading.2',
        'heading.3',
        'list.ordered.1',
        'list.unordered.1',
        'subtitle.1',
        'table.body',
        'table.caption',
        'table.header'
      ].sort()
    )
  })

  it('候选集合：默认与完整备选可用，缺键备选不可用并给出明细（软校验不拒载）', () => {
    const mgr = createManager()
    const demo = mgr.findStructureByName('示例文档模板 (Demo)')!
    const candidates = mgr.styleCandidatesForStructure(demo)
    expect(candidates).toHaveLength(3)

    const byKey = Object.fromEntries(candidates.map((c) => [c.fileKey, c]))
    expect(byKey['demo-stylemap']!.available).toBe(true)
    expect(byKey['demo-stylemap']!.isDefault).toBe(true)
    expect(byKey['demo-alt-full-stylemap']!.available).toBe(true)
    expect(byKey['demo-alt-full-stylemap']!.isDefault).toBe(false)

    const missing = byKey['demo-alt-missing-stylemap']!
    expect(missing.available).toBe(false)
    expect(missing.missingKeys).toContain('figure.caption')

    // 软校验：结构模板照常加载
    expect(mgr.listStructures()).toHaveLength(1)
    expect(mgr.defaultStyleCandidate(demo)!.fileKey).toBe('demo-stylemap')
  })

  it('旧格式兼容：无 styleTemplates 时回退单元素集合', async () => {
    const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'tpl-legacy-'))
    try {
      const base = join(dir, 'templates')
      mkdirSync(join(base, 'structures', 'legacy'), { recursive: true })
      mkdirSync(join(base, 'styles', 'legacy'), { recursive: true })
      // 结构模板（旧格式：仅 styleTemplate）
      writeFileSync(
        join(base, 'manifest.json'),
        JSON.stringify({
          structures: [
            { id: 'legacy', name: '旧格式模板', file: 'legacy-structure.json' }
          ],
          styles: [
            { id: 'legacy', name: '旧格式样式', stylemap_file: 'legacy-stylemap.json', style_folder: 'legacy-style' }
          ]
        }),
        'utf8'
      )
      writeFileSync(
        join(base, 'structures', 'legacy', 'legacy-structure.json'),
        JSON.stringify({
          name: '旧格式模板',
          styleTemplate: 'legacy-stylemap',
          root: { nodeType: 'root', title: '旧文档', children: [] }
        }),
        'utf8'
      )
      writeFileSync(
        join(base, 'styles', 'legacy', 'legacy-stylemap.json'),
        JSON.stringify({ name: '旧格式样式', docxFolder: 'legacy-style', styleMap: { heading: 'x' } }),
        'utf8'
      )
      const mgr = new TemplateManager()
      mgr.loadTemplateDir(base)
      const def = mgr.findStructureByName('旧格式模板')!
      expect(def.styleTemplates).toEqual(['legacy-stylemap'])
      expect(def.styleTemplate).toBe('legacy-stylemap')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
