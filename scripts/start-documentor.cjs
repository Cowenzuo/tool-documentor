#!/usr/bin/env node
/**
 * start-documentor.cjs —— 一键启动。
 *
 * **默认启动打包好的发布版**（release/win-unpacked/Documentor.exe，产物在仓库根）。
 * 开发时才启开发版，两种方式：
 *   - 传 --dev： node scripts/start-documentor.cjs --dev
 *   - 或在本仓库根建一个名为 .dev-mode 的空文件（谁在这台机器上开发就建一个）
 *
 * ⚠️ `.dev-mode` 是**机器级开关**，对所有启动方式生效——包括别人双击安装包建出来的快捷方式。
 *    在一台共享机器上建了它，别人也会跑到开发版（还要现编库，等十几秒）。
 *    所以开发完记得删掉：`del .dev-mode`。该文件已在 .gitignore 里，不会入库。
 *
 * 为什么默认发布版：改工程数据要用固定快照，开发版跑的是随时会变的工作树代码，
 * 出了问题分不清是数据还是程序。分界见工程工作区 ../tool-documentor-projs/README.md 第 0 节。
 *
 * 这个脚本要跑在用户机器上，所以**只用 Node 内建模块**，不用 chalk/inquirer 之类的依赖。
 */
const { existsSync, readdirSync, statSync } = require('node:fs')
const { join, resolve, dirname } = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const ROOT = resolve(__dirname, '..')
const RELEASE_EXE = join(ROOT, 'release', 'win-unpacked', 'Documentor.exe')
const RELEASE_DIR = join(ROOT, 'release')
const DEV_MARKER = join(ROOT, '.dev-mode')

const argv = process.argv.slice(2)
const forceDev = argv.includes('--dev')
const forceRelease = argv.includes('--release')
/** 由 .cmd 传入：跑完等一次按键，双击窗口才不会一闪而过 */
const HOLD = process.env['DOC_START_HOLD'] === '1'

function say(msg) {
  console.log(msg)
}

function hold() {
  if (!HOLD) return
  console.log('')
  console.log('按任意键关闭…')
  try {
    // Windows 上同步阻塞读一个字符；失败就算了，不影响主流程
    spawnSync('cmd', ['/c', 'pause>nul'], { stdio: 'inherit' })
  } catch {
    /* 忽略 */
  }
}

/**
 * 找 release 下的安装包（免安装版缺失时给用户指路）。
 * 同一目录里可能并排躺着几版安装包，取**最新那一版**：按文件修改时间排，
 * 时间相同再按名字倒序，免得指到旧版本上。
 */
function findInstaller() {
  if (!existsSync(RELEASE_DIR)) return null
  const hits = readdirSync(RELEASE_DIR)
    .filter((n) => /^Documentor-.*-setup\.exe$/iu.test(n))
    .map((n) => ({ name: n, mtime: statSync(join(RELEASE_DIR, n)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
  return hits.length > 0 ? join(RELEASE_DIR, hits[0].name) : null
}

function hasPnpm() {
  const r = spawnSync('pnpm', ['--version'], { shell: true, stdio: 'ignore' })
  return r.status === 0
}

function runInherit(cmd, args) {
  return new Promise((resolveDone) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true })
    child.on('exit', (code) => resolveDone(code ?? 0))
    child.on('error', () => resolveDone(1))
  })
}

async function startRelease() {
  say(`[发布版] ${RELEASE_EXE}`)
  const child = spawn(RELEASE_EXE, [], { detached: true, stdio: 'ignore' })
  child.unref()
  say('已启动。')
  return 0
}

async function startDev() {
  const why = forceDev ? '命令行 --dev' : '检测到 .dev-mode 标记'
  say(`[开发版] 进入原因：${why}`)
  say('这条路径跑的是当前工作树代码，只用来开发新功能；改工程数据请用发布版。')
  if (!hasPnpm()) {
    console.error('[错误] 未找到 pnpm。Node.js 自带 corepack，请先执行: corepack enable')
    return 1
  }
  if (!existsSync(join(ROOT, 'node_modules'))) {
    say('[提示] 首次运行，正在安装依赖（pnpm install）…')
    const code = await runInherit('pnpm', ['install'])
    if (code !== 0) {
      console.error('[错误] 依赖安装失败，请检查网络后重试。')
      return 1
    }
  }
  say('[1/2] 检查 workspace 库（core/templates/postprocess/docx）…')
  const libs = await runInherit('node', [join('scripts', 'ensure-libs.cjs')])
  if (libs !== 0) {
    console.error('[错误] 库构建失败，请检查上方报错信息。')
    return 1
  }
  say('[2/2] 启动开发版（electron-vite dev）…')
  const code = await runInherit('pnpm', ['--filter', '@documentor/desktop', 'dev'])
  say('')
  say('应用已退出。')
  return code
}

async function main() {
  // 明确指定优先：--dev 与 --release 同时给时以 --dev 为准（开发意图更强）
  if (forceDev) return startDev()
  if (!forceRelease && existsSync(DEV_MARKER)) return startDev()

  if (existsSync(RELEASE_EXE)) return startRelease()

  // 没有发布版：说清怎么产出，并把开发版作为退路
  const installer = findInstaller()
  console.error('[错误] 没有找到打包好的发布版：')
  console.error(`        ${RELEASE_EXE}`)
  if (installer) {
    console.error('')
    console.error('        但找到了安装包，可以装一个：')
    console.error(`        ${installer}`)
  }
  console.error('')
  console.error('        要现场打包（需要 GitHub 网络，安装包构建期要下载 winCodeSign）：')
  console.error('          pnpm package:dir     # 免安装版')
  console.error('          pnpm package         # NSIS 安装包')
  console.error('')
  console.error('        要用开发版启动（跑当前工作树代码）：')
  console.error('          node scripts/start-documentor.cjs --dev')
  return 1
}

main()
  .then((code) => {
    hold()
    process.exit(code)
  })
  .catch((err) => {
    console.error('[错误]', err && err.message ? err.message : err)
    hold()
    process.exit(1)
  })
