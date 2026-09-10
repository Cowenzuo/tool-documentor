/**
 * check-upstream.cjs — 上游 mmd2vsdx 契约锚定检查。上游接口一变，这里就红灯。
 *
 * 目的：让"上游接口漂移"在提交/发布前立刻红灯，而不是被假转换器与优雅降级掩盖。
 * 做法：只做静态检查（读 package.json 与入口文件文本），不 import 上游模块，
 *       因此可在 `pnpm verify` 里快速运行；真实转换行为由
 *       `packages/docx/tests/mmd2vsdx.contract.test.ts`（DOC_REAL_MMD=1）负责。
 *
 * 期望契约（上游改造完成后应达到的形态）：
 *   - 包根导出可解析，且声明类型（package.json "types" 或 exports["."].types）
 *   - 入口模块导出门面 convertText / shutdown（或导出 application 对象承载两者）
 *
 * 退出码：0 = 契约一致；1 = 漂移（打印期望/实际差异与修复指引）
 * 用法：node scripts/check-upstream.cjs
 */
const { existsSync, readFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
/** 声明了对 mmd2vsdx 依赖的 workspace 包（resolve 起点） */
const CONSUMERS = ['apps/desktop', 'packages/docx']
/** 门面必须提供的成员（新形态：命名导出；旧形态：application 对象成员） */
const FACADE_MEMBERS = ['convertText', 'shutdown']

function resolveUpstreamPackageJson() {
  for (const consumer of CONSUMERS) {
    try {
      return require.resolve('mmd2vsdx/package.json', { paths: [join(ROOT, consumer)] })
    } catch {
      /* 试下一个消费者 */
    }
  }
  return null
}

/** 从 exports["."] 解析入口文件相对路径（支持字符串 / {import,require,default} 形态） */
function entryRelPath(pkg) {
  const root = pkg.exports && pkg.exports['.']
  const pick = (v) => {
    if (typeof v === 'string') return v
    if (v && typeof v === 'object') return v.import ?? v.require ?? v.default ?? v.types ?? null
    return null
  }
  return pick(root) ?? pick(pkg.main) ?? null
}

function typesRelPath(pkg) {
  const root = pkg.exports && pkg.exports['.']
  const fromExports = root && typeof root === 'object' ? root.types ?? null : null
  return fromExports ?? (typeof pkg.types === 'string' ? pkg.types : null)
}

/** 静态判断入口文本是否导出某个名字（命名导出或导出列表中包含） */
function exportsName(source, name) {
  const patterns = [
    new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`),
    new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`),
    new RegExp(`export\\s+default\\s+[^\\n]*\\b${name}\\b`)
  ]
  return patterns.some((re) => re.test(source))
}

function main() {
  const problems = []
  const notes = []

  const pkgJsonPath = resolveUpstreamPackageJson()
  if (!pkgJsonPath) {
    console.error('[check-upstream] ✗ 未找到 mmd2vsdx（请先 pnpm install；依赖为 link: 外部目录）')
    process.exit(1)
  }

  const pkgRoot = dirname(pkgJsonPath)
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  console.log(`[check-upstream] mmd2vsdx @ ${pkg.version ?? '(无版本)'}`)
  console.log(`[check-upstream] 上游包根：${pkgRoot}`)

  if (pkg.name !== 'mmd2vsdx') problems.push(`包名不符：期望 mmd2vsdx，实际 ${pkg.name}`)

  const entryRel = entryRelPath(pkg)
  if (!entryRel) {
    problems.push('未声明可解析的包入口（package.json exports["."] / main 均缺失）')
  }

  let source = ''
  if (entryRel) {
    const entryAbs = join(pkgRoot, entryRel)
    if (!existsSync(entryAbs)) {
      problems.push(`入口文件不存在：${entryRel}`)
    } else {
      source = readFileSync(entryAbs, 'utf8')
      console.log(`[check-upstream] 入口：${entryRel}`)
    }
  }

  const hasApplication = source !== '' && exportsName(source, 'application')
  const missing = FACADE_MEMBERS.filter((m) => !exportsName(source, m))
  if (source !== '') {
    if (missing.length === 0) {
      notes.push(`门面命名导出齐全：${FACADE_MEMBERS.join(' / ')}`)
    } else if (hasApplication) {
      notes.push('检测到旧形态 application 对象；成员形状由真实契约测试验证')
    } else {
      problems.push(
        `入口缺少门面导出：${missing.join(' / ')}（当前导出：${listExports(source)}）`
      )
    }
  }

  const typesRel = typesRelPath(pkg)
  if (!typesRel) {
    problems.push('未声明类型（package.json "types" 或 exports["."].types 缺失）')
  } else if (!existsSync(join(pkgRoot, typesRel))) {
    problems.push(`类型文件不存在：${typesRel}`)
  } else {
    console.log(`[check-upstream] 类型：${typesRel}`)
  }

  for (const n of notes) console.log(`[check-upstream] · ${n}`)

  if (problems.length === 0) {
    console.log('[check-upstream] ✓ 上游契约一致')
    process.exit(0)
  }

  console.error('[check-upstream] ✗ 上游契约漂移：')
  for (const p of problems) console.error(`  - ${p}`)
  console.error('')
  console.error('  这是"接口已变化"的信号，不是构建故障。')
  console.error('  处理：对齐 packages/docx/src/figure-export.ts 里的门面解析，')
  console.error('        再按本脚本第 9 行起的期望契约更新。')
  console.error('  注意：当前红灯为预期状态（P0-1 尚未执行）。')
  process.exit(1)
}

/** 粗列入口导出名（仅用于诊断输出） */
function listExports(source) {
  const names = new Set()
  const re = /export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g
  for (const m of source.matchAll(re)) names.add(m[1])
  const reList = /export\s*\{([^}]*)\}/g
  for (const m of source.matchAll(reList)) {
    for (const raw of m[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop()
      if (name) names.add(name.trim())
    }
  }
  return names.size > 0 ? [...names].join(', ') : '（未识别）'
}

main()
