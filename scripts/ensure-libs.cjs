/**
 * ensure-libs.cjs —— 只在库源码真的变了时才构建 workspace 库。
 *
 * 为什么需要它：`pnpm build:libs` 是四个包各起一次 pnpm + tsc，实测约 4.4 秒
 * （其中真正的编译约 2.4 秒，其余是进程启动开销）。而库源码平时一天也改不了几次，
 * 每次启动都重编一遍纯属白等。
 *
 * 做法：把四个包 src/ 下的文件清单 + 修改时间指纹存到仓库根的 .libs-build-hash，
 * 与当前指纹比对。一致就跳过构建，不一致或指纹缺失就跑 pnpm build:libs。
 *
 * 正确性：指纹含文件名，因此新增与删除源文件都会让它变化（只比时间戳会漏掉删除）。
 * 若你改了构建配置（tsconfig.build.json）而不改 src，指纹不变——此时手动跑
 * `pnpm build:libs` 或删掉 .libs-build-hash 即可。
 *
/**
 * 用法：node scripts/ensure-libs.cjs          # 需要时构建
 *       node scripts/ensure-libs.cjs --force  # 无条件构建
 *       node scripts/ensure-libs.cjs --mark   # 只刷新指纹（手工跑过 build:libs 后调用）
 *
 * 注意：直接 `pnpm build:libs` **不会**刷新指纹文件，之后 ensure-libs 会因指纹不符而重编
 * 一次（安全但多余）。要让指纹跟上，在那之后跑一次 `--mark`（`pnpm build:libs:mark` 已封装）。
 */
const { createHash } = require('node:crypto')
const { execSync } = require('node:child_process')
const { existsSync, readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const HASH_FILE = join(ROOT, '.libs-build-hash')
const LIBS = ['core', 'templates', 'postprocess', 'docx']
/**
 * 时间戳容差：某些文件系统（与 utimes 对齐后）只有秒级精度，
 * 同秒不同毫秒会造成反复误判。1 秒以内视为同步。
 */
const MTIME_TOLERANCE_MS = 1000

/** 一个包的源文件指纹：路径 + 修改时间 + 大小，按路径排序后拼接 */
function fingerprintDir(dir) {
  const parts = []
  const walk = (d, prefix) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const st = statSync(p)
      if (st.isDirectory()) walk(p, `${prefix}${name}/`)
      else parts.push(`${prefix}${name}:${st.mtimeMs}:${st.size}`)
    }
  }
  walk(dir, '')
  return parts.join('|')
}

/**
 * 兜底检查：逐个源文件与它对应的编译产物比时间，产物缺失或更旧 → 必须重编。
 *
 * 为什么不能只看"目录里最新时间"：tsc 对**内容未变**的文件会跳过写入，
 * 所以碰过一下源码（内容没改）就会让 src 永远比 dist 新，判据失效。
 * 逐文件对应比较没有这个问题，也能兜住"手工 build:libs 后指纹没刷"的情况。
 *
 * 说明：源码改了但 TS 判定输出字节完全相同（如纯类型改动）时，dist 不会被重写，
 * 这里会多编一次——宁可多编，也不能让 dist 落后于 src。
 */
function staleByMtime() {
  const stale = []
  for (const lib of LIBS) {
    const srcDir = join(ROOT, 'packages', lib, 'src')
    const distDir = join(ROOT, 'packages', lib, 'dist')
    if (!existsSync(srcDir)) continue
    let affected = 0
    const walk = (d, prefix) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name)
        const st = statSync(p)
        if (st.isDirectory()) {
          walk(p, `${prefix}${name}/`)
          continue
        }
        if (!name.endsWith('.ts')) continue
        // 手写声明文件（*.d.ts）不产出 .js，跳过
        if (name.endsWith('.d.ts')) continue
        const outFile = join(distDir, `${prefix}${name.replace(/\.ts$/, '.js')}`)
        if (!existsSync(outFile)) {
          affected++
          continue
        }
        if (st.mtimeMs > statSync(outFile).mtimeMs + MTIME_TOLERANCE_MS) affected++
      }
    }
    walk(srcDir, '')
    if (affected > 0) stale.push(`${lib}（${affected} 个产物缺失或落后）`)
  }
  return stale
}

function currentFingerprint() {
  const h = createHash('sha256')
  for (const lib of LIBS) {
    const srcDir = join(ROOT, 'packages', lib, 'src')
    const distDir = join(ROOT, 'packages', lib, 'dist')
    h.update(`${lib}:`)
    if (existsSync(srcDir)) h.update(fingerprintDir(srcDir))
    // 构建配置也纳入指纹：改 tsconfig.build.json 同样需要重编
    const cfg = join(ROOT, 'packages', lib, 'tsconfig.build.json')
    if (existsSync(cfg)) h.update(`|cfg:${readFileSync(cfg, 'utf8')}`)
    h.update(`|dist:${existsSync(distDir) ? '1' : '0'}`)
  }
  return h.digest('hex')
}

function main() {
  const force = process.argv.includes('--force')
  if (force) {
    console.log('[ensure-libs] --force：无条件构建')
    build()
    return
  }

  // 只刷新指纹：供手工跑完 build:libs 后调用，避免下一次 ensure-libs 白重编一遍
  if (process.argv.includes('--mark')) {
    writeFileSync(HASH_FILE, currentFingerprint(), 'utf8')
    console.log('[ensure-libs] 指纹已刷新（--mark）')
    return
  }

  const current = currentFingerprint()
  const previous = existsSync(HASH_FILE) ? readFileSync(HASH_FILE, 'utf8').trim() : ''

  // 指纹一致即视为最新。
  // 这里刻意不叠加时间戳判据：源码改了但 tsc 判定输出字节完全相同（纯类型改动）时
  // 产物不会被重写，mtime 会一直落后，叠加判据会导致每次启动都白编一遍。
  if (previous === current) {
    console.log('[ensure-libs] 库源码未变化，跳过构建（省约 4 秒）')
    console.log('[ensure-libs] 需要强制重建：pnpm build:libs，或删掉仓库根的 .libs-build-hash')
    return
  }

  // 指纹不一致：再用逐文件时间戳判据说明原因（手工 build:libs 后指纹没刷的情形）
  const stale = staleByMtime()
  if (stale.length > 0) {
    console.log(`[ensure-libs] 检测到构建产物落后于源码（${stale.join('、')}），正在构建…`)
  } else {
    console.log(
      previous
        ? '[ensure-libs] 检测到库源码变化，正在构建…'
        : '[ensure-libs] 首次运行或缓存缺失，正在构建…'
    )
  }
  build()
}

function build() {
  try {
    execSync('pnpm build:libs', { cwd: ROOT, stdio: 'inherit', shell: true })
  } catch {
    console.error('[ensure-libs] ✗ 库构建失败，请检查上方报错。')
    process.exit(1)
  }
  // 构建成功后才写指纹，失败时下次仍会重试
  writeFileSync(HASH_FILE, currentFingerprint(), 'utf8')
  console.log('[ensure-libs] 构建完成，指纹已更新')
}

main()
