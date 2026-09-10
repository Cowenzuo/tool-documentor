/**
 * e2e-smoke.cjs — 生产产物 E2E 冒烟：起真实 Electron，跑一遍打开工程到导出的主流程。
 *
 * 约定：**所有临时产物落在仓库 `temp/`**（gitignored），不写入系统临时目录。
 * 流程：构建后的渲染层产物 → electron-vite preview 启动 Electron →
 *       DOC_E2E 驱动 DOM 全流程（新建工程/编辑/保存/导出/预览/设置）→ 打印结果 JSON。
 *
 * 用法（仓库根）：
 *   node scripts/e2e-smoke.cjs            # 跑完清理工作区
 *   node scripts/e2e-smoke.cjs --keep     # 保留 temp/e2e-<时间戳>/ 供检查
 *   node scripts/e2e-smoke.cjs --templates <dir>   # 覆盖模板目录（缺省合成夹具）
 *
 * 退出码：0 = E2E 通过；1 = 失败/超时。
 */
const { spawn, execSync } = require('node:child_process')
const { mkdirSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const TEMP_ROOT = join(ROOT, 'temp')
const FIXTURE = join(ROOT, 'samples', 'sample-template')
const TIMEOUT_MS = 180_000

function parseArgs(argv) {
  let keep = false
  let templates = FIXTURE
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--keep') keep = true
    else if (argv[i] === '--templates' && argv[i + 1]) {
      templates = resolve(argv[i + 1])
      i++
    }
  }
  return { keep, templates }
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' })
    else process.kill(-pid, 'SIGKILL')
  } catch {
    /* 进程可能已退出 */
  }
}

function main() {
  const { keep, templates } = parseArgs(process.argv.slice(2))
  const workspace = join(TEMP_ROOT, `e2e-${Date.now()}`)
  mkdirSync(workspace, { recursive: true })
  console.log(`[e2e-smoke] 工作区：${workspace}`)
  console.log(`[e2e-smoke] 模板目录：${templates}`)

  const child = spawn('pnpm', ['--filter', '@documentor/desktop', 'start'], {
    cwd: ROOT,
    shell: true,
    env: {
      ...process.env,
      DOC_E2E: workspace,
      DOC_E2E_TEMPLATES: templates
    }
  })

  let settled = false
  let buffer = ''

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 结束：先杀进程树，等句柄释放后清理工作区（Windows 上立即删除常因句柄未释放失败） */
  const finish = async (code) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    killTree(child.pid)
    await sleep(800)
    if (!keep) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          rmSync(workspace, { recursive: true, force: true })
          break
        } catch {
          await sleep(500)
        }
      }
    } else {
      console.log(`[e2e-smoke] 已保留工作区：${workspace}`)
    }
    process.exit(code)
  }

  const timer = setTimeout(() => {
    console.error(`[e2e-smoke] ✗ 超时（${TIMEOUT_MS / 1000}s）`)
    void finish(1)
  }, TIMEOUT_MS)

  const onChunk = (chunk) => {
    const text = chunk.toString()
    process.stdout.write(text)
    buffer += text
    // 渲染层控制台告警/CSP 违规（主进程 E2E 钩子转发）
    for (const line of text.split(/\r?\n/)) {
      if (line.includes('[renderer:')) console.warn(`[e2e-smoke] 注意：${line.trim()}`)
    }
    const m = buffer.match(/\[e2e\] (\{[\s\S]*?\})\s*\n/)
    if (m) {
      try {
        const data = JSON.parse(m[1])
        const ok = data.editor === true && data.welcome === true
        console.log(`[e2e-smoke] ${ok ? '✓ 通过' : '✗ 关键断言失败'}：${JSON.stringify(data)}`)
        void finish(ok ? 0 : 1)
      } catch (err) {
        console.error('[e2e-smoke] ✗ 结果 JSON 解析失败：', err.message)
        void finish(1)
      }
    }
  }

  child.stdout.on('data', onChunk)
  child.stderr.on('data', onChunk)
  child.on('exit', (code) => {
    if (!settled) {
      console.error(`[e2e-smoke] ✗ Electron 进程提前退出（code=${code}）`)
      void finish(1)
    }
  })
}

main()
