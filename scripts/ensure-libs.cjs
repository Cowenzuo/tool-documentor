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
 * 用法：node scripts/ensure-libs.cjs          # 需要时构建
 *       node scripts/ensure-libs.cjs --force  # 无条件构建
 */
const { createHash } = require('node:crypto')
const { execSync } = require('node:child_process')
const { existsSync, readdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const HASH_FILE = join(ROOT, '.libs-build-hash')
const LIBS = ['core', 'templates', 'postprocess', 'docx']

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

  const current = currentFingerprint()
  const previous = existsSync(HASH_FILE) ? readFileSync(HASH_FILE, 'utf8').trim() : ''

  if (previous === current) {
    console.log('[ensure-libs] 库源码未变化，跳过构建（省约 4 秒）')
    console.log('[ensure-libs] 需要强制重建：pnpm build:libs，或删掉仓库根的 .libs-build-hash')
    return
  }

  console.log(
    previous
      ? '[ensure-libs] 检测到库源码变化，正在构建…'
      : '[ensure-libs] 首次运行或缓存缺失，正在构建…'
  )
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
