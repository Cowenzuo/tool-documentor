/**
 * e2e-smoke.cjs — 生产产物 E2E 冒烟：起真实 Electron，跑一遍打开工程到导出的主流程。
 *
 * 约定：**所有临时产物落在仓库 `temp/`**（gitignored），不写入系统临时目录。
 * 流程：构建后的渲染层产物 → electron-vite preview 启动 Electron →
 *       DOC_E2E 驱动 DOM 全流程（新建工程/编辑/保存/导出/预览/设置）→ 打印结果 JSON →
 *       再用 sendInputEvent 重放一次真实鼠标点击（[e2e-phys]），两段都验。
 *
 * 前置：本脚本**不构建**，跑之前必须有最新的 out/。用 `pnpm e2e`（含 pnpm build），
 *       直接 node 调用只适合刚构建完的场景。
 *
 * 用法（仓库根）：
 *   pnpm e2e                              # 构建 + 冒烟，跑完清理工作区
 *   node scripts/e2e-smoke.cjs --keep     # 保留 temp/e2e-<时间戳>/ 供检查
 *   node scripts/e2e-smoke.cjs --templates <dir>   # 覆盖模板目录（缺省合成夹具）
 *
 * 退出码：0 = E2E 通过；1 = 失败/超时。
 */
const { spawn, execSync } = require('node:child_process')
const { existsSync, mkdirSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')

const ROOT = resolve(__dirname, '..')
const TEMP_ROOT = join(ROOT, 'temp')
const FIXTURE = join(ROOT, 'samples', 'sample-template')
const TIMEOUT_MS = 180_000
/** 关键断言通过后，等物理点击结果的时间上限 */
const PHYS_GRACE_MS = 15_000

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

/**
 * 检查探针产出的结果。
 * 以前只断言 editor/welcome/deleteOk 三项：导出失败、预览空白、设置打不开都会照样绿。
 */
function checkResult(data) {
  const problems = []
  const need = (ok, message) => {
    if (!ok) problems.push(message)
  }
  need(data.welcome === true, '欢迎页未出现')
  need(data.wizardOpen === true, '新建向导未打开')
  need(data.editor === true, '编辑器未出现')
  need(
    data.deleteOk === true,
    `删除内容块未生效：按钮=${data.deleteBtnFound} ` +
      `${data.biaoShi && data.biaoShi.blockCards} → ${data.blockCardsAfterDelete}，` +
      `提示=${data.deleteToast}`
  )
  need(data.exportDialogOpen === true, '导出对话框未打开')
  need(
    typeof data.exportToast === 'string' && data.exportToast.includes('导出') && !data.exportToast.includes('失败'),
    `导出结果提示异常：${data.exportToast}`
  )
  need(data.previewPage === true, '预览视图未渲染')
  need(data.backToEdit === true, '从预览切回编辑失败')
  need(data.settingsOpen === true, '设置弹层未打开')
  need(data.settingsClosed === true, '设置弹层未关闭')
  need(
    Array.isArray(data.themeOptions) && data.themeOptions.length === 3,
    `设置里应有主题三选项：${JSON.stringify(data.themeOptions)}`
  )
  need(data.themeSwitchOk === true, '设置里的主题切换未生效或未恢复原偏好')
  need(
    Array.isArray(data.settingsSections) && data.settingsSections.includes('主题'),
    `设置分区缺少主题：${JSON.stringify(data.settingsSections)}`
  )
  need(
    Array.isArray(data.settingsFootButtons) &&
      data.settingsFootButtons.includes('取消') &&
      data.settingsFootButtons.includes('保存设置'),
    `设置底部缺少取消/保存：${JSON.stringify(data.settingsFootButtons)}`
  )
  need(
    typeof data.settingsHintChars === 'number' && data.settingsHintChars < 160,
    `设置里的说明文字过长（${data.settingsHintChars} 字符），又回到大段注释了`
  )
  need(
    Array.isArray(data.tbActions) &&
      ['保存', '导出', '定位', '退出'].every((label) => data.tbActions.includes(label)),
    `标题栏工程操作组不齐：${JSON.stringify(data.tbActions)}`
  )
  need(typeof data.treeRows === 'number' && data.treeRows > 1, `树行数异常：${data.treeRows}`)
  return problems
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
  let resultData = null
  let physTimer = null
  /** 渲染层 CSP 违规：脚本被拦意味着功能静默失效，必须让冒烟红 */
  const cspViolations = []

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  /** 结束：先杀进程树，等句柄释放后清理工作区（Windows 上立即删除常因句柄未释放失败） */
  const finish = async (code) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (physTimer) clearTimeout(physTimer)
    killTree(child.pid)
    await sleep(800)
    if (keep) {
      console.log(`[e2e-smoke] 已保留工作区：${workspace}`)
      process.exit(code)
    }
    let removed = false
    for (let attempt = 0; attempt < 5 && !removed; attempt++) {
      try {
        rmSync(workspace, { recursive: true, force: true })
      } catch {
        await sleep(500)
      }
      removed = !existsSync(workspace)
    }
    if (!removed) {
      console.warn(`[e2e-smoke] 注意：工作区未能清理，可能有残留进程占用句柄：${workspace}`)
    }
    process.exit(code)
  }

  const timer = setTimeout(() => {
    console.error(`[e2e-smoke] ✗ 超时（${TIMEOUT_MS / 1000}s）`)
    void finish(1)
  }, TIMEOUT_MS)

  // Ctrl+C / 被终止时也要收尾，否则会留下拿着工程数据库句柄的 Electron 进程
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.warn(`[e2e-smoke] 收到 ${sig}，清理后退出`)
      void finish(1)
    })
  }

  const onChunk = (chunk) => {
    const text = chunk.toString()
    process.stdout.write(text)
    buffer += text
    // 渲染层控制台告警/CSP 违规（主进程 E2E 钩子转发）
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('[renderer:')) continue
      const trimmed = line.trim()
      if (trimmed.includes('/csp')) {
        cspViolations.push(trimmed)
        console.error(`[e2e-smoke] ✗ CSP 违规：${trimmed}`)
      } else {
        console.warn(`[e2e-smoke] 注意：${trimmed}`)
      }
    }
    // 探针抛错时主进程只打印一行，早退比等到 180s 超时更能指出问题
    const failed = /\[e2e\] failed: (.*)/.exec(buffer)
    if (failed) {
      console.error(`[e2e-smoke] ✗ 界面探针执行失败：${failed[1].trim()}`)
      void finish(1)
      return
    }
    const m = buffer.match(/\[e2e\] (\{[\s\S]*?\})\s*\n/)
    if (m && resultData === null) {
      try {
        resultData = JSON.parse(m[1])
      } catch (err) {
        console.error('[e2e-smoke] ✗ 结果 JSON 解析失败：', err.message)
        void finish(1)
        return
      }
      const problems = checkResult(resultData)
      console.log(`[e2e-smoke] 探针结果：${JSON.stringify(resultData)}`)
      if (problems.length > 0) {
        for (const p of problems) console.error(`[e2e-smoke] ✗ ${p}`)
        console.error(`[e2e-smoke] ✗ 关键断言失败（${problems.length} 项）`)
        void finish(1)
        return
      }
      console.log('[e2e-smoke] 关键断言通过，等待物理点击验证…')
      physTimer = setTimeout(() => {
        console.error('[e2e-smoke] ✗ 未收到物理点击验证结果（[e2e-phys]）')
        void finish(1)
      }, PHYS_GRACE_MS)
      return
    }
    // 物理点击结果：主进程在探针之后重放真实鼠标点击，1.4s 后才打印
    const phys = /\[e2e-phys\] toast= (.*)/.exec(buffer)
    if (phys && resultData !== null && physTimer) {
      clearTimeout(physTimer)
      physTimer = null
      const toast = phys[1].trim()
      const toastOk = toast.length > 0 && toast !== 'null' && !toast.includes('失败')
      const cspOk = cspViolations.length === 0
      if (!toastOk) console.error(`[e2e-smoke] ✗ 物理点击保存未生效：toast=${toast}`)
      if (!cspOk) {
        console.error(`[e2e-smoke] ✗ 渲染层有 ${cspViolations.length} 条 CSP 违规，被拦的脚本不会执行`)
      }
      const ok = toastOk && cspOk
      console.log(`[e2e-smoke] ${ok ? '✓ 全部通过' : '✗ 收尾断言失败'}：物理点击 toast=${toast}，CSP 违规 ${cspViolations.length} 条`)
      void finish(ok ? 0 : 1)
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
