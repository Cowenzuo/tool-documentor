/**
 * mmd2vsdx.contract.test.ts — 上游真实契约测试。默认跳过，设 DOC_REAL_MMD=1 才跑。
 *
 * 默认跳过；`DOC_REAL_MMD=1` 时运行（需本机 Chromium，无需 Visio）。
 * 与 figure-export.test.ts 的分工：那里的转换器是**注入的假实现**（覆盖编排分支），
 * 这里**不注入**，直接走真实上游加载器 → 真实 Mermaid→VSDX 转换 → 真实 OLE 嵌入，
 * 因此上游接口一旦漂移就会立刻红灯（而不是被降级逻辑掩盖）。
 *
 * 运行：
 *   pnpm --filter @documentor/docx test:real                       # 合成夹具（1 图）
 *   DOC_REAL_MMD_TEMPLATE=localtest/templates \
 *   DOC_REAL_MMD_STRUCTURE="<结构模板名>" \
 *   pnpm --filter @documentor/docx test:real                       # 本地真实模板（如 438C SDD 12 图）
 *
 * 可选环境变量：
 *   DOC_REAL_MMD_TEMPLATE   模板目录（缺省 = resources/test-fixtures/sample-template）
 *   DOC_REAL_MMD_STRUCTURE  结构模板名（缺省 = 该目录第一个结构模板）
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
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
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const FIXTURE = fileURLToPath(
  new URL('../../../resources/test-fixtures/sample-template/', import.meta.url)
)
/** 相对路径按仓库根解析（测试 cwd 是 packages/docx，不是仓库根） */
const TEMPLATE_DIR = (() => {
  const raw = process.env['DOC_REAL_MMD_TEMPLATE']
  if (!raw) return FIXTURE
  return isAbsolute(raw) ? raw : resolvePath(REPO_ROOT, raw)
})()
const STRUCTURE_NAME = process.env['DOC_REAL_MMD_STRUCTURE'] || ''
const HINT =
  '图嵌入服务不可用：上游 mmd2vsdx 的接口可能已经变化，先跑 node scripts/check-upstream.cjs 看契约差异'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'docx-mmd-contract-'))
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** 加载指定模板目录的结构模板；树中无 Mermaid 时补一个，保证至少验证 1 图 */
function loadTreeWithMermaid(): { tree: DocumentTree; style: StyleTemplateDef } {
  const manager = new TemplateManager()
  manager.loadTemplateDir(TEMPLATE_DIR)
  const structures = manager.listStructures()
  if (structures.length === 0) throw new Error(`模板目录无结构模板：${TEMPLATE_DIR}`)
  const def = STRUCTURE_NAME
    ? manager.findStructureByName(STRUCTURE_NAME)
    : structures[0]
  if (!def) {
    throw new Error(
      `未找到结构模板「${STRUCTURE_NAME}」；可用：${structures.map((s) => s.name).join('、')}`
    )
  }
  const tree = manager.instantiate(def)
  if (!tree) throw new Error(`结构模板实例化失败：${def.name}`)
  const style = manager.styleForStructure(def)
  if (!style) throw new Error(`结构模板「${def.name}」无可用样式模板`)

  const countMermaid = (n: DocumentNode): number =>
    n.contentBlocks.filter((b) => b.type === 'mermaid').length +
    n.children.reduce((s, c) => s + countMermaid(c), 0)
  if (countMermaid(tree.root) === 0) {
    const target = (function find(n: DocumentNode): DocumentNode | null {
      if (n.allowContentBlocks) return n
      for (const c of n.children) {
        const hit = find(c)
        if (hit) return hit
      }
      return null
    })(tree.root)
    if (!target) throw new Error('结构模板无允许内容块的节点')
    target.contentBlocks.push({
      type: 'mermaid',
      caption: '图1 契约测试流程',
      code: 'graph TD\n  A[开始] --> B[结束]'
    })
  }
  console.log(
    `[contract] 模板=${def.name} 目录=${TEMPLATE_DIR} 图块=${countMermaid(tree.root)}`
  )
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
      const s = result.figureStats
      console.log(
        `[contract] total=${s.total} converted=${s.converted} embedded=${s.embedded} preview=${s.previewCount}`
      )

      expect(s.total, HINT).toBeGreaterThanOrEqual(1)
      expect(s.failed, HINT).toEqual([])
      expect(s.converted, HINT).toBe(s.total)
      expect(s.embedded, HINT).toBe(s.total)
      expect(s.previewCount, HINT).toBeGreaterThanOrEqual(0)

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
