/**
 * mmd2vsdx.contract.test.ts — 上游真实契约测试（PLAN-05 P0-2）
 *
 * 默认跳过；`DOC_REAL_MMD=1` 时运行（需本机 Chromium，无需 Visio）。
 * 与 figure-export.test.ts 的分工：那里的转换器是**注入的假实现**（覆盖编排分支），
 * 这里**不注入**，直接走真实上游加载器 → 真实 Mermaid→VSDX 转换 → 真实 OLE 嵌入，
 * 因此上游接口一旦漂移就会立刻红灯（而不是被降级逻辑掩盖）。
 *
 * 运行：pnpm --filter @documentor/docx test:real
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { resetIdCounterForTest } from '@documentor/core/idgen'
import { TemplateManager } from '@documentor/templates'
import type { StyleTemplateDef } from '@documentor/templates'
import type { DocumentTree, DocumentNode } from '@documentor/core/tree'
import { parseCompoundFile } from '@documentor/postprocess'
import { exportTreeToDocxWithFigures } from '../src/index'

const REAL = process.env['DOC_REAL_MMD'] === '1'
const SAMPLE = fileURLToPath(
  new URL('../../../resources/test-fixtures/sample-template/', import.meta.url)
)
const HINT =
  '图嵌入服务不可用——上游 mmd2vsdx 接口可能已变化，见 docs/UPSTREAM-mmd2vsdx.md 与 docs/PLAN-05-修复方案.md P0-1'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'docx-mmd-contract-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 加载合成示例模板，并确保树中至少有一个 Mermaid 块 */
function loadTreeWithMermaid(): { tree: DocumentTree; style: StyleTemplateDef } {
  const manager = new TemplateManager()
  manager.loadTemplateDir(SAMPLE)
  const def = manager.findStructureByName('示例文档模板 (Demo)')
  const tree = def && manager.instantiate(def)
  if (!def || !tree) throw new Error('示例模板加载失败')
  const style = manager.styleForStructure(def)
  if (!style) throw new Error('示例样式加载失败')

  const hasMermaid = (n: DocumentNode): boolean =>
    n.contentBlocks.some((b) => b.type === 'mermaid') || n.children.some(hasMermaid)
  if (!hasMermaid(tree.root)) {
    const target = (function find(n: DocumentNode): DocumentNode | null {
      if (n.allowContentBlocks) return n
      for (const c of n.children) {
        const hit = find(c)
        if (hit) return hit
      }
      return null
    })(tree.root)
    if (!target) throw new Error('示例模板无允许内容块的节点')
    target.contentBlocks.push({
      type: 'mermaid',
      caption: '图1 契约测试流程',
      code: 'graph TD\n  A[开始] --> B[结束]'
    })
  }
  return { tree, style }
}

describe.skipIf(!REAL)('mmd2vsdx 真实契约（DOC_REAL_MMD=1）', () => {
  it(
    '真实转换 + OLE 嵌入：产出含 Visio OLE 对象的 docx',
    async () => {
      resetIdCounterForTest()
      const { tree, style } = loadTreeWithMermaid()
      const finalPath = join(dir, 'contract-embed.docx')

      const result = await exportTreeToDocxWithFigures(tree, style, finalPath, {})

      expect(result.figureStats.total, HINT).toBeGreaterThanOrEqual(1)
      expect(result.figureStats.failed, HINT).toEqual([])
      expect(result.figureStats.converted, HINT).toBe(result.figureStats.total)
      expect(result.figureStats.embedded, HINT).toBe(result.figureStats.total)
      expect(result.figureStats.previewCount, HINT).toBeGreaterThanOrEqual(0)

      const zip = await JSZip.loadAsync(readFileSync(finalPath))
      const doc = await zip.file('word/document.xml')!.async('string')
      expect(doc, HINT).toContain('<o:OLEObject Type="Embed" ProgID="Visio.Drawing.15"')
      expect(doc, HINT).not.toContain('[Mermaid')

      const ole = await zip.file('word/embeddings/oleObject1.bin')!.async('uint8array')
      const cfb = parseCompoundFile(ole)
      expect(cfb['Package']!.length, `${HINT}（OLE 容器内无 Package 流）`).toBeGreaterThan(0)
    },
    240_000
  )
})
