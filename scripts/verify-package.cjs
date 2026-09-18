/**
 * verify-package.cjs — 打包产物内容校验：必需项齐全、上游不入包、无开发依赖泄漏。
 *
 * 校验两件事：
 *   1. 运行必需项存在（out 三段产物 + workspace 库 dist + jszip）；
 *   2. 分发禁止项缺失（决策 C1：mmd2vsdx 及其官方母版内容不得入包；
 *      同时排除 source map 与开发依赖，避免体积与合规问题）。
 *
 * 前置：先产出解包目录（仓库根执行）
 *   pnpm package:dir        # 需要网络可用；离线时复用本地 Electron 二进制
 * 用法：
 *   node scripts/verify-package.cjs
 */
const { existsSync, readFileSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
// 产物在仓库根的 release/（electron-builder.yml 的 directories.output 上溯了两级）
const UNPACKED = join(ROOT, 'release', 'win-unpacked')
const ASAR = join(UNPACKED, 'resources', 'app.asar')

/** 必需项（任一缺失即失败） */
const REQUIRED = [
  ['主进程产物', 'out/main/index.js'],
  ['预加载产物', 'out/preload/index.js'],
  ['渲染层页面', 'out/renderer/index.html'],
  ['@documentor/core dist', 'node_modules/@documentor/core/dist/index.js'],
  ['@documentor/docx dist', 'node_modules/@documentor/docx/dist/index.js'],
  ['@documentor/templates dist', 'node_modules/@documentor/templates/dist/index.js'],
  ['@documentor/postprocess dist', 'node_modules/@documentor/postprocess/dist/index.js'],
  ['jszip', 'node_modules/jszip/package.json']
]

/** 禁止项（命中即失败）；reason 说明为什么不能进包 */
const FORBIDDEN = [
  { test: (p) => p.includes('mmd2vsdx'), reason: 'C1 版权边界：上游含官方 Visio 母版 XML' },
  { test: (p) => p.endsWith('.map'), reason: 'source map 不入发行包' },
  { test: (p) => p.includes('node_modules/electron-builder/'), reason: '开发依赖' },
  { test: (p) => p.includes('node_modules/electron-vite/'), reason: '开发依赖' },
  { test: (p) => p.includes('node_modules/typescript/'), reason: '开发依赖' },
  { test: (p) => p.includes('node_modules/vitest/'), reason: '开发依赖' },
  { test: (p) => p.includes('node_modules/electron/dist/'), reason: 'Electron 二进制已在外层，不应再入 asar' }
]

function loadAsar() {
  const pnpmDir = join(ROOT, 'node_modules', '.pnpm')
  if (!existsSync(pnpmDir)) return null
  const hit = readdirSync(pnpmDir).find((d) => d.startsWith('@electron+asar@'))
  if (!hit) return null
  return require(join(pnpmDir, hit, 'node_modules', '@electron', 'asar'))
}

function main() {
  if (!existsSync(ASAR)) {
    console.error(`[verify-package] ✗ 未找到产物：${ASAR}`)
    console.error('  先执行 pnpm package:dir，再回来跑本脚本')
    process.exit(1)
  }
  const asar = loadAsar()
  if (!asar) {
    console.error('[verify-package] ✗ 未找到 @electron/asar（请先安装 electron-builder 依赖）')
    process.exit(1)
  }

  // listPackage 返回以反斜杠分隔的路径，统一为 '/'
  const entries = asar.listPackage(ASAR).map((p) => p.replace(/\\/g, '/'))
  console.log(`[verify-package] app.asar 条目数：${entries.length}`)

  const problems = []

  for (const [label, needle] of REQUIRED) {
    const ok = entries.some((p) => p === `/${needle}` || p.endsWith(`/${needle}`))
    console.log(`  ${ok ? '✓' : '✗'} ${label}  (${needle})`)
    if (!ok) problems.push(`缺少必需项：${label}（${needle}）`)
  }

  for (const { test, reason } of FORBIDDEN) {
    const hit = entries.find(test)
    if (hit) {
      console.log(`  ✗ 禁止项命中：${hit}`)
      problems.push(`禁止项入包：${hit}（${reason}）`)
    }
  }

  const mmd = entries.filter((p) => p.includes('mmd2vsdx')).length
  console.log(`[verify-package] mmd2vsdx 条目：${mmd}（期望 0）`)

  // 顶层 node_modules 包清单 + 开发依赖泄漏检查
  const top = new Map()
  for (const e of entries) {
    const m = /^\/node_modules\/((?:@[^/]+\/[^/]+)|[^/]+)\//.exec(e)
    if (m) top.set(m[1], (top.get(m[1]) ?? 0) + 1)
  }
  const names = [...top.keys()].sort()
  console.log(`[verify-package] 顶层依赖包：${names.length} 个`)
  if (process.argv.includes('--list')) console.log(names.join(', '))

  const appPkg = JSON.parse(readFileSync(join(ROOT, 'packages', 'desktop', 'package.json'), 'utf8'))
  const devDeps = Object.keys(appPkg.devDependencies ?? {})
  for (const dep of devDeps) {
    if (top.has(dep)) {
      console.log(`  ✗ 开发依赖入包：${dep}`)
      problems.push(`开发依赖入包：${dep}`)
    }
  }

  const sizeMb = (readFileSync(ASAR).length / 1024 / 1024).toFixed(1)
  console.log(`[verify-package] app.asar 体积：${sizeMb} MB`)

  if (problems.length === 0) {
    console.log('[verify-package] ✓ 产物内容符合要求')
    process.exit(0)
  }
  console.error('[verify-package] ✗ 产物内容不符合要求：')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

main()
