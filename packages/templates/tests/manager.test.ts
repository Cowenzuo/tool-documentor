/** manager.test.ts — 模板加载、配对校验与实例化的单测。 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resetIdCounterForTest } from '@documentor/core'
import type { ContentBlock } from '@documentor/core'
import { TemplateManager, requiredStyleKeys } from '../src/manager'

const SAMPLE = fileURLToPath(new URL('../../../samples/sample-template/', import.meta.url))

function createManager(): TemplateManager {
  const mgr = new TemplateManager()
  mgr.loadTemplateDir(SAMPLE)
  return mgr
}

/**
 * 造一个最小模板目录（只有一份结构模板）。
 * manifest 的 name 与结构 JSON 的 name 分开传，用于钉住「注册键取 JSON 的 name」。
 */
function writeStructureDir(
  base: string,
  jsonName: string,
  rootTitle: string,
  manifestName: string
): string {
  mkdirSync(join(base, 'structures', 's'), { recursive: true })
  writeFileSync(
    join(base, 'manifest.json'),
    JSON.stringify({ structures: [{ id: 's', name: manifestName, file: 's.json' }] }),
    'utf8'
  )
  writeFileSync(
    join(base, 'structures', 's', 's.json'),
    JSON.stringify({ name: jsonName, root: { nodeType: 'root', title: rootTitle } }),
    'utf8'
  )
  return base
}

describe('示例模板资产加载（samples/sample-template，合成无版权数据）', () => {
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

  it('骨架里查不到的 styleId 必须报出来（校验真的在起作用）', () => {
    // 反向用例：上面的"全部命中"不能只证明示例数据恰好正确，
    // 还要能在 styleId 打错时报出来。示例骨架里有 49/45/60 等，没有 99999。
    const mgr = createManager()
    const base = mgr.findStyleTemplate('demo-stylemap')!
    const broken = { ...base, styleMap: { ...base.styleMap, body: '99999' } }
    const report = mgr.validateStyleTemplate(broken)
    expect(report.valid).toBe(false)
    expect(report.missing).toEqual([{ logicalName: 'body', styleId: '99999' }])
    // 骨架读不到（路径不存在）时也要报，而不是当成功
    const noSkeleton = { ...base, skeletonPath: `${base.skeletonPath}-不存在` }
    expect(mgr.validateStyleTemplate(noSkeleton).valid).toBe(false)
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
      items: ['条目一：示例', '条目二：示例', '条目三：示例'],
      lock: 'keep'
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

describe('内容块模板锁 lock（只认三档，非法取值按不锁处理）', () => {
  it('合法取值随实例化带到块上，没写 lock 的块不带这个字段', () => {
    resetIdCounterForTest()
    const mgr = createManager()
    const demo = mgr.findStructureByName('示例文档模板 (Demo)')!
    const tree = mgr.instantiate(demo)!
    const byTitle = new Map<string, ContentBlock[]>()
    tree.traverse((n) => byTitle.set(n.title, n.contentBlocks))

    expect(byTitle.get('标识')![0]).toEqual({
      type: 'orderedList',
      items: ['条目一：示例', '条目二：示例', '条目三：示例'],
      lock: 'keep'
    })
    expect(byTitle.get('概述')![0]!.lock).toBe('readonly')
    const demand = byTitle.get('需求')!
    expect(demand.find((b) => b.type === 'mermaid')!.lock).toBe('type')
    // 没写 lock 的块不长出这个字段（老数据与老模板的行为不变）
    expect(demand.find((b) => b.type === 'code')!).not.toHaveProperty('lock')
    expect(byTitle.get('引用文档')![0]!).not.toHaveProperty('lock')
  })

  it('解析阶段滤掉非法取值：块不带锁，并在加载报告里记一条告警', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-lock-'))
    try {
      const base = join(dir, 'templates')
      mkdirSync(join(base, 'structures', 'lockcase'), { recursive: true })
      writeFileSync(
        join(base, 'manifest.json'),
        JSON.stringify({
          structures: [{ id: 'lockcase', name: '锁测试模板', file: 'lock-structure.json' }]
        }),
        'utf8'
      )
      writeFileSync(
        join(base, 'structures', 'lockcase', 'lock-structure.json'),
        JSON.stringify({
          name: '锁测试模板',
          root: {
            nodeType: 'root',
            title: '锁测试',
            contentBlocks: [
              { type: 'text', content: '模板给定的定稿', lock: 'readonly' },
              { type: 'text', content: '取值写错', lock: '必锁' },
              { type: 'text', content: '取值不是字符串', lock: 3 },
              { type: 'text', content: '没写锁' }
            ]
          }
        }),
        'utf8'
      )
      const mgr = new TemplateManager()
      const result = mgr.loadTemplateDir(base)
      const def = mgr.findStructureByName('锁测试模板')!
      expect(def.rootDef.contentBlocks.map((b) => b.lock)).toEqual([
        'readonly',
        undefined,
        undefined,
        undefined
      ])
      // 非法取值要留下痕迹，不能静默：整份模板照常加载，只出一条警告
      expect(result.skipped).toEqual([])
      expect(result.warnings).toHaveLength(2)
      expect(result.warnings.join('\n')).toContain('必锁')
      expect(result.warnings.join('\n')).toContain('锁测试模板')

      const tree = mgr.instantiate(def)!
      expect(tree.root.contentBlocks[0]!.lock).toBe('readonly')
      expect(tree.root.contentBlocks[1]!).not.toHaveProperty('lock')
      expect(tree.root.contentBlocks[2]!).not.toHaveProperty('lock')
      expect(tree.root.contentBlocks[3]!).not.toHaveProperty('lock')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('加载报告：跳过的条目与可疑取值都要有记录', () => {
  it('结构缺 name / 缺 root、stylemap 缺 name / 缺 styleMap 都进 skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-broken-'))
    try {
      const base = join(dir, 'templates')
      mkdirSync(join(base, 'structures', 'n'), { recursive: true })
      mkdirSync(join(base, 'structures', 'r'), { recursive: true })
      mkdirSync(join(base, 'styles', 's'), { recursive: true })
      writeFileSync(
        join(base, 'manifest.json'),
        JSON.stringify({
          structures: [
            { id: 'n', name: '缺 name', file: 'no-name.json' },
            { id: 'r', name: '缺 root', file: 'no-root.json' }
          ],
          styles: [
            { id: 's', name: '缺 name 的样式', stylemap_file: 'no-name-stylemap.json' },
            { id: 's', name: '缺 styleMap 的样式', stylemap_file: 'no-map-stylemap.json' }
          ]
        }),
        'utf8'
      )
      writeFileSync(
        join(base, 'structures', 'n', 'no-name.json'),
        JSON.stringify({ root: { nodeType: 'root', title: '没有名字' } }),
        'utf8'
      )
      writeFileSync(
        join(base, 'structures', 'r', 'no-root.json'),
        JSON.stringify({ name: '缺少 root 的模板' }),
        'utf8'
      )
      writeFileSync(
        join(base, 'styles', 's', 'no-name-stylemap.json'),
        JSON.stringify({ styleMap: { body: '1' } }),
        'utf8'
      )
      writeFileSync(
        join(base, 'styles', 's', 'no-map-stylemap.json'),
        JSON.stringify({ name: '缺 styleMap 的样式' }),
        'utf8'
      )

      const mgr = new TemplateManager()
      const result = mgr.loadTemplateDir(base)
      // 一份都没加载到，但报告里必须逐条说清是哪份、为什么
      expect(result.structuresLoaded).toBe(0)
      expect(result.stylesLoaded).toBe(0)
      expect(result.skipped).toHaveLength(4)
      const joined = result.skipped.join('\n')
      for (const file of [
        'no-name.json',
        'no-root.json',
        'no-name-stylemap.json',
        'no-map-stylemap.json'
      ]) {
        expect(joined).toContain(file)
      }
      expect(joined).toContain('解析失败')
      expect(result.warnings).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('认不出的内容块类型进 skipped，实例化时确实少那一块', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-unknown-block-'))
    try {
      const base = join(dir, 'templates')
      mkdirSync(join(base, 'structures', 'b'), { recursive: true })
      writeFileSync(
        join(base, 'manifest.json'),
        JSON.stringify({
          structures: [{ id: 'b', name: '未知块模板', file: 'block-structure.json' }]
        }),
        'utf8'
      )
      writeFileSync(
        join(base, 'structures', 'b', 'block-structure.json'),
        JSON.stringify({
          name: '未知块模板',
          root: {
            nodeType: 'root',
            title: '未知块',
            contentBlocks: [
              { type: 'video', content: '认不出的块' },
              { type: 'text', content: '留得住的块' },
              { content: '连 type 都没写' }
            ]
          }
        }),
        'utf8'
      )
      const mgr = new TemplateManager()
      const result = mgr.loadTemplateDir(base)
      expect(result.skipped).toHaveLength(2)
      const joined = result.skipped.join('\n')
      expect(joined).toContain('video')
      expect(joined).toContain('（空）')
      expect(joined).toContain('未知块模板')
      expect(joined).toContain('未知块') // 节点标题，便于作者定位

      const tree = mgr.instantiate(mgr.findStructureByName('未知块模板')!)!
      expect(tree.root.contentBlocks).toHaveLength(1)
      expect(tree.root.contentBlocks[0]).toMatchObject({ type: 'text', content: '留得住的块' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('模板块纵向合并开关 mergeVertical（只认布尔 true）', () => {
  it('模板里写了 true 的表格块，解析与实例化都带上该标志', () => {
    resetIdCounterForTest()
    const mgr = createManager()
    const demo = mgr.findStructureByName('示例文档模板 (Demo)')!
    // 夹具「引用文档」那张表写了 mergeVertical: true
    const defTables = demo.rootDef.defaultChildren[1]!.contentBlocks.filter((b) => b.type === 'table')
    expect(defTables).toHaveLength(1)
    expect(defTables[0]!.mergeVertical).toBe(true)

    // 旧实现解析阶段从不读这个字段，实例化时那行 if 永远不成立，块上拿不到
    const tree = mgr.instantiate(demo)!
    const tables: ContentBlock[] = []
    tree.traverse((n) => tables.push(...n.contentBlocks.filter((b) => b.type === 'table')))
    expect(tables).toHaveLength(1)
    expect(tables[0]).toHaveProperty('mergeVertical', true)
  })

  it('没写、写了 false / 字符串 / 数字都不产生该键', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-merge-'))
    try {
      const base = join(dir, 'templates')
      mkdirSync(join(base, 'structures', 'merge'), { recursive: true })
      writeFileSync(
        join(base, 'manifest.json'),
        JSON.stringify({
          structures: [{ id: 'merge', name: '合并开关模板', file: 'merge-structure.json' }]
        }),
        'utf8'
      )
      writeFileSync(
        join(base, 'structures', 'merge', 'merge-structure.json'),
        JSON.stringify({
          name: '合并开关模板',
          root: {
            nodeType: 'root',
            title: '合并开关',
            contentBlocks: [
              { type: 'table', caption: '表1 没写', headers: ['A'], data: [['1']] },
              { type: 'table', caption: '表2 false', mergeVertical: false, headers: ['A'], data: [['1']] },
              { type: 'table', caption: '表3 字符串', mergeVertical: 'true', headers: ['A'], data: [['1']] },
              { type: 'table', caption: '表4 数字', mergeVertical: 1, headers: ['A'], data: [['1']] },
              { type: 'table', caption: '表5 true', mergeVertical: true, headers: ['A'], data: [['1']] }
            ]
          }
        }),
        'utf8'
      )
      const mgr = new TemplateManager()
      mgr.loadTemplateDir(base)
      const def = mgr.findStructureByName('合并开关模板')!
      expect(def.rootDef.contentBlocks.map((b) => b.mergeVertical)).toEqual([
        undefined,
        undefined,
        undefined,
        undefined,
        true
      ])
      const blocks = mgr.instantiate(def)!.root.contentBlocks
      for (const block of blocks.slice(0, 4)) expect(block).not.toHaveProperty('mergeVertical')
      expect(blocks[4]).toHaveProperty('mergeVertical', true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

describe('结构模板注册键口径（以模板 JSON 的 name 为准，manifest 只做发现）', () => {
  it('同名两份：先加载的胜出，报告里记下被忽略的那份与双方来源目录', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-dup-'))
    try {
      const first = writeStructureDir(join(dir, 'first'), '同名模板', '先加载的标题', '同名模板')
      // 第二份的 manifest name 与 JSON name 不一致：旧实现拿 manifest name 去重
      // （表里没有「别名乙」这个名字），于是解析后按 JSON 的 name 静默替换掉第一份
      const second = writeStructureDir(join(dir, 'second'), '同名模板', '后加载的标题', '别名乙')

      const mgr = new TemplateManager()
      const r1 = mgr.loadTemplateDir(first)
      const r2 = mgr.loadTemplateDir(second)

      expect(r1.structuresLoaded).toBe(1)
      expect(r2.structuresLoaded).toBe(0)
      const structures = mgr.listStructures()
      expect(structures).toHaveLength(1)
      expect(structures[0]!.rootDef.defaultTitle).toBe('先加载的标题')

      const record = r2.skipped.find((s) => s.startsWith('structure already loaded'))
      expect(record).toBeDefined()
      expect(record).toContain('同名模板')
      expect(record).toContain(first) // 胜出者的来源目录
      expect(record).toContain(second) // 被忽略者的来源目录
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('manifest 与 JSON 名字不一致时按 JSON 的名字注册', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-manifest-name-'))
    try {
      const base = writeStructureDir(join(dir, 'a'), '正名模板', '正名文档', '清单里的旧名')
      const mgr = new TemplateManager()
      const result = mgr.loadTemplateDir(base)

      expect(result.structuresLoaded).toBe(1)
      expect(mgr.findStructureByName('正名模板')).toBeDefined()
      expect(mgr.findStructureByName('正名模板')!.rootDef.defaultTitle).toBe('正名文档')
      // manifest 的 name 不参与注册，查不到是预期行为
      expect(mgr.findStructureByName('清单里的旧名')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不同名的两份都能加载，互不影响', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tpl-distinct-'))
    try {
      const a = writeStructureDir(join(dir, 'a'), '甲模板', '甲文档', '甲模板')
      const b = writeStructureDir(join(dir, 'b'), '乙模板', '乙文档', '乙模板')
      const mgr = new TemplateManager()
      expect(mgr.loadTemplateDir(a).structuresLoaded).toBe(1)
      const rb = mgr.loadTemplateDir(b)
      expect(rb.structuresLoaded).toBe(1)
      expect(rb.skipped).toEqual([])
      expect(mgr.listStructures().map((s) => s.name).sort()).toEqual(['乙模板', '甲模板'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

  it('候选可用性也要看骨架：styleId 在 styles.xml 里查不到就不算可用', () => {
    // 上面那条走的是"逻辑键缺失"分支；这里专门覆盖"键齐全但 styleId 打错"，
    // 也就是 styleCandidatesForStructure 里合并 validateStyleTemplate 结果的那段。
    const mgr = createManager()
    const demo = mgr.findStructureByName('示例文档模板 (Demo)')!
    const base = mgr.findStyleTemplate('demo-stylemap')!
    const broken = { ...base, styleMap: { ...base.styleMap, body: '99999' } }
    // 用坏样式顶掉注册表里的同名项，候选查询才会走到它
    ;(mgr as unknown as { styles: Map<string, unknown> }).styles.set(base.name, broken)
    ;(mgr as unknown as { styles: Map<string, unknown> }).styles.set(base.fileKey, broken)

    const candidate = mgr
      .styleCandidatesForStructure(demo)
      .find((c) => c.fileKey === 'demo-stylemap')!
    expect(candidate.available).toBe(false)
    expect(candidate.missingKeys.join(' ')).toContain('body')
    expect(candidate.missingKeys.join(' ')).toContain('99999')
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

  it('stylemap 解析 field 题注模式、章节样式名与骨架标题起始编号', async () => {
    const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'tpl-field-'))
    try {
      const base = join(dir, 'templates')
      mkdirSync(join(base, 'styles', 'f', 'f-style', 'word'), { recursive: true })
      writeFileSync(
        join(base, 'manifest.json'),
        JSON.stringify({
          styles: [
            {
              id: 'f',
              name: '域样式',
              stylemap_file: 'f-stylemap.json',
              style_folder: 'f-style'
            }
          ]
        }),
        'utf8'
      )
      writeFileSync(
        join(base, 'styles', 'f', 'f-stylemap.json'),
        JSON.stringify({
          name: '域样式',
          docxFolder: 'f-style',
          captionNumbering: {
            table: 'field',
            figure: 'field',
            chapterStyleNames: { '2': '标题 2', '3': '标题 3' }
          },
          styleMap: { body: '1' }
        }),
        'utf8'
      )
      writeFileSync(
        join(base, 'styles', 'f', 'f-style', 'word', 'styles.xml'),
        '<w:styles><w:style w:styleId="1"/></w:styles>',
        'utf8'
      )
      // 第一个 abstractNum：标题 1 从 4 起，其余从 1 起
      writeFileSync(
        join(base, 'styles', 'f', 'f-style', 'word', 'numbering.xml'),
        '<w:numbering><w:abstractNum w:abstractNumId="0">' +
          '<w:lvl w:ilvl="0"><w:start w:val="4"/></w:lvl>' +
          '<w:lvl w:ilvl="1"><w:start w:val="1"/></w:lvl>' +
          '</w:abstractNum></w:numbering>',
        'utf8'
      )
      const mgr = new TemplateManager()
      mgr.loadTemplateDir(base)
      const style = mgr.findStyleTemplate('f-stylemap')!
      expect(style.captionNumbering?.table).toBe('field')
      expect(style.captionNumbering?.figure).toBe('field')
      expect(style.captionNumbering?.chapterStyleNames).toEqual({ '2': '标题 2', '3': '标题 3' })
      expect(style.headingStarts?.[0]).toBe(4)
      expect(style.headingStarts?.[1]).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
