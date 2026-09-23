/**
 * mmd-service.ts — mmd2vsdx 转换服务的客户端（主进程）。
 *
 * 形态（2026-09 定案）：上游是**本机常驻 HTTP 服务**，我方只做三件事——
 * 探测、按需点火、逐张请求。**不持有服务的任何生命周期**：不记 pid、不 kill、
 * App 退出不关它（上游也没有 /shutdown）。契约见上游 `docs/接口协议.md`。
 *
 * 两个路由（唯一用到的）：
 *   GET  <endpoint>/health    弱确认：200 且 contractVersion === 1
 *   POST <endpoint>/convert   请求体是 mermaid 原文，响应体就是 .vsdx 字节
 *
 * 分层：本文件是纯 Node（不 import electron），配置由调用方现读注入，
 * 所以能在单测里用 `node:http` 起个假服务把它跑穿。落盘、命名、临时文件都不在这里
 * ——服务不落盘，字节进内存直接交给 @documentor/postprocess 装配。
 *
 * 停手闸门（三条，都是防"一次坏掉拖成长跑"）：
 *   1. 可重试类（429 / 504）重试一次，仍失败算单张失败；
 *   2. 连接类失败（连不上）整体不可用 → 点火一次 → 再试一次 → 仍不行就整体降级；
 *   3. **连续 3 张超时**整体不可用：真卡超时不止等 15 秒，上游会重建浏览器再回 504，
 *      后面的请求全在排队，不设这条会一路试到底。
 */
import { spawn } from 'node:child_process'
import { closeSync, openSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { locateNode, type NodeProbe } from './node-locate'
import type {
  MmdHealthDto,
  MmdNodeProbeDto,
  MmdServiceConfigDto,
  MmdStartResultDto,
  MmdStatusDto
} from '../../shared/project'

// ================= 常量与配置 =================

/** 上游契约版本；对不上就明确报错，不静默降级（上游文档明确要求） */
export const MMD_CONTRACT_VERSION = 1
/** 弱确认超时：探测不该让界面等 */
export const MMD_PROBE_TIMEOUT_MS = 500
/** 没读到 /health 时的兜底单请求超时（读到以后用 timeoutMs + 余量） */
export const MMD_CONVERT_TIMEOUT_MS = 20_000
/** 服务端超时之外留的余量：让服务端先回 504，我方别抢跑 */
export const MMD_CONVERT_TIMEOUT_SLACK_MS = 5000
/** 连续多少张超时就整体停手 */
export const MMD_TIMEOUT_STREAK_LIMIT = 3
/** 点火后等就绪的上限 */
export const MMD_START_WAIT_MS = 20_000
export const MMD_START_POLL_MS = 250
/** 可重试类失败的重试退避 */
export const MMD_RETRY_DELAY_MS = 1000
/** 服务端入口（相对 mmd2vsdx 目录） */
export const MMD_SERVER_ENTRY = join('bin', 'mmd2vsdx-server.mjs')

export type MmdServiceConfig = MmdServiceConfigDto

export const DEFAULT_MMD_CONFIG: MmdServiceConfig = {
  enabled: true,
  node_path: '',
  dir: '',
  endpoint: 'http://127.0.0.1:12138',
  auto_start: true
}

/** 读配置时把脏值收敛回可用形状（config.json 是用户可编辑的） */
export function normalizeMmdConfig(raw: unknown): MmdServiceConfig {
  const r = (raw ?? {}) as Partial<MmdServiceConfig>
  const endpoint = String(r.endpoint ?? '').trim()
  return {
    enabled: r.enabled !== false,
    node_path: String(r.node_path ?? '').trim(),
    dir: String(r.dir ?? '').trim(),
    endpoint: endpoint === '' ? DEFAULT_MMD_CONFIG.endpoint : endpoint,
    auto_start: r.auto_start !== false
  }
}

// ================= 探测结果 =================

export type MmdProbeResult =
  | { ok: true; health: MmdHealthDto }
  | { ok: false; kind: MmdProbeFailureKind; reason: string; detail?: string }

export type MmdProbeFailureKind = 'disabled' | 'unreachable' | 'contract-mismatch' | 'bad-response'

/** 单张失败 / 整体不可用 / 我方请求写错 */
export type MmdFailureKind = 'single' | 'unavailable' | 'request-bug'

export interface MmdConvertSuccess {
  ok: true
  bytes: Uint8Array
  sha256?: string
  kind?: string
  serviceVersion?: string
  /** 上游的不阻断提示（缺官方母版之类）；**不给用户看**，进日志 */
  warnings: string[]
}

export interface MmdConvertFailure {
  ok: false
  kind: MmdFailureKind
  /** 上游错误码；连不上时是我方自造的 `unreachable` / `timeout` / `contract_mismatch` */
  code: string
  message: string
  hint?: string
  /** 已经重试过一次 */
  retried?: boolean
}

export type MmdConvertResult = MmdConvertSuccess | MmdConvertFailure

// ================= 点火 =================

export type MmdStartPlan =
  | {
      ok: true
      nodePath: string
      /** 是否要给子进程带 ELECTRON_RUN_AS_NODE=1 */
      electronAsNode: boolean
      args: string[]
      cwd: string
      port: number
      /** 给人看的一行命令，设置页显示用 */
      command: string
    }
  | { ok: false; reason: 'no-node' | 'no-dir' | 'bad-endpoint'; detail: string }

export interface SpawnedServer {
  pid: number | undefined
  /** 已经退出则给退出码，还在跑给 null */
  exitCode(): number | null
}

// ================= 依赖注入 =================

export interface MmdServiceDeps {
  /** 现读配置（设置里改完即时生效，不缓存） */
  getConfig: () => MmdServiceConfig
  /** Node 定位；缺省走 node-locate 的真实实现 */
  locate?: (explicit: string) => Promise<{ picked: NodeProbe | null; all: NodeProbe[] }>
  /** Electron 可执行文件（兜底候选）；主进程传 process.execPath */
  electronPath?: string
  /** detached 点火；缺省走 child_process.spawn，测试注入可以不下真进程 */
  spawnDetached?: (plan: Extract<MmdStartPlan, { ok: true }>, logFile: string | null) => SpawnedServer
  /** 子进程日志落哪（缺省不落盘）；点火失败要读它的尾部 */
  logFile?: () => string | null
  /** fetch 实现（缺省全局 fetch） */
  fetchImpl?: typeof fetch
  /** 睡（重试退避与轮询用）；测试调小 */
  sleep?: (ms: number) => Promise<void>
  /** 覆盖探测超时（测试用；缺省 500ms） */
  probeTimeoutMs?: number
  /** 覆盖单请求转换超时（测试用；缺省按 /health 的 timeoutMs + 余量） */
  convertTimeoutMs?: number
  retryDelayMs?: number
  startWaitMs?: number
  startPollMs?: number
  log?: (line: string) => void
}

// ================= 实现 =================

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class MmdService {
  private readonly deps: MmdServiceDeps
  private lastHealth: MmdHealthDto | null = null
  private lastProbe: MmdProbeResult | null = null
  private lastProbeAt = 0
  /** 连续超时的张数（成功或非超时失败都会清零） */
  private timeoutStreak = 0
  /** 本次会话是否已经为"崩了再拉一次"点过火 */
  private reviveAttempted = false

  constructor(deps: MmdServiceDeps) {
    this.deps = deps
  }

  private get fetchImpl(): typeof fetch {
    return this.deps.fetchImpl ?? fetch
  }

  private get sleep(): (ms: number) => Promise<void> {
    return this.deps.sleep ?? sleepDefault
  }

  private log(line: string): void {
    this.deps.log?.(line)
  }

  /** 最近一次成功的 /health（导出时用它的 timeoutMs 决定我方超时） */
  get health(): MmdHealthDto | null {
    return this.lastHealth
  }

  // ---------- 探测 ----------

  /** 现读配置；`override` 是设置页"拿表单现值试一下"的临时覆盖，**不落盘、不进缓存** */
  private cfg(override?: MmdServiceConfig): MmdServiceConfig {
    return override ?? this.deps.getConfig()
  }

  /** 弱确认：200 且契约版本对得上 */
  async probe(override?: MmdServiceConfig): Promise<MmdProbeResult> {
    const cfg = this.cfg(override)
    if (!cfg.enabled) {
      return { ok: false, kind: 'disabled', reason: '图转换已关闭' }
    }
    const result = await this.probeOnce(cfg.endpoint)
    // 覆盖探测是"试一下"，结果不能污染导出用的缓存
    if (!override) {
      this.lastProbe = result
      this.lastProbeAt = Date.now()
      if (result.ok) this.lastHealth = result.health
    }
    return result
  }

  /**
   * 带缓存的探测。导出对话框会反复问"能不能用"，不能每次都打 /health；
   * `cacheMs <= 0` 表示"这次要新鲜的"，其余情况命中缓存就直接返回上次结果。
   */
  async probeCached(cacheMs: number): Promise<MmdProbeResult> {
    if (cacheMs > 0 && this.lastProbe && Date.now() - this.lastProbeAt <= cacheMs) {
      return this.lastProbe
    }
    return this.probe()
  }

  private async probeOnce(endpoint: string): Promise<MmdProbeResult> {
    let res: Response
    try {
      res = await this.fetchImpl(urlOf(endpoint, '/health'), {
        method: 'GET',
        signal: AbortSignal.timeout(this.deps.probeTimeoutMs ?? MMD_PROBE_TIMEOUT_MS)
      })
    } catch (err) {
      return { ok: false, kind: 'unreachable', reason: '转换服务没在运行', detail: messageOf(err) }
    }
    if (!res.ok) {
      // 状态码进日志（`detail`），界面上只说"没正常响应"
      return { ok: false, kind: 'unreachable', reason: '转换服务没有正常响应', detail: `HTTP ${res.status}` }
    }
    let body: unknown
    try {
      body = await res.json()
    } catch (err) {
      return { ok: false, kind: 'bad-response', reason: '转换服务没有正常响应', detail: messageOf(err) }
    }
    const health = parseHealth(body)
    if (!health) {
      return { ok: false, kind: 'bad-response', reason: '转换服务没有正常响应', detail: '健康信息读不出来' }
    }
    if (health.contractVersion !== MMD_CONTRACT_VERSION) {
      return {
        ok: false,
        kind: 'contract-mismatch',
        reason: `转换服务的版本与本软件不匹配（它 ${health.contractVersion}，本软件要 ${MMD_CONTRACT_VERSION}）`,
        detail: `服务版本 ${health.serviceVersion}`
      }
    }
    return { ok: true, health }
  }

  // ---------- 点火 ----------

  /** 组装点火命令；设置页也用它显示"将要执行什么" */
  async buildStartPlan(override?: MmdServiceConfig): Promise<MmdStartPlan> {
    const cfg = this.cfg(override)
    const parsed = parseEndpoint(cfg.endpoint)
    if (!parsed) {
      return { ok: false, reason: 'bad-endpoint', detail: '服务地址只能是本机回环地址，形如 http://127.0.0.1:12138' }
    }
    if (cfg.dir === '') {
      return { ok: false, reason: 'no-dir', detail: '还没有指定服务程序目录' }
    }
    const located = this.deps.locate
      ? await this.deps.locate(cfg.node_path)
      : await locateNode({
          explicit: cfg.node_path,
          electronPath: this.deps.electronPath
        })
    if (!located.picked) {
      return {
        ok: false,
        reason: 'no-node',
        detail:
          cfg.node_path !== ''
            ? `指定的运行环境用不了：${located.all[0]?.reason ?? '原因不明'}`
            : '没找到可用的运行环境（需要 22.2 以上）'
      }
    }
    const nodePath = located.picked.path
    const entry = join(cfg.dir, MMD_SERVER_ENTRY)
    const args = [entry, '--port', String(parsed.port)]
    return {
      ok: true,
      nodePath,
      electronAsNode: located.picked.electronAsNode === true,
      args,
      cwd: cfg.dir,
      port: parsed.port,
      command: `"${nodePath}" "${entry}" --port ${parsed.port}`
    }
  }

  /**
   * 探测 → 不通就点火 → 轮询到就绪。**永不持有句柄**：点完火就撒手，
   * 不记 pid、不管它以后怎么退出（App 退出也不关它）。
   */
  async ensureRunning(override?: MmdServiceConfig): Promise<MmdStartResultDto> {
    const first = await this.probe(override)
    if (first.ok) {
      return { ok: true, started: false, reason: '转换服务已在运行', health: first.health }
    }
    if (first.kind === 'disabled') {
      return { ok: false, started: false, reason: first.reason }
    }
    const cfg = this.cfg(override)
    if (!cfg.auto_start) {
      return {
        ok: false,
        started: false,
        reason: first.reason,
        detail: `${first.detail ?? ''}（按设置不自动启动）`.trim()
      }
    }

    const plan = await this.buildStartPlan(override)
    if (!plan.ok) return { ok: false, started: false, reason: plan.detail, detail: plan.reason }

    const logFile = this.deps.logFile?.() ?? null
    this.log(`[mmd] 启动转换服务：${plan.command}`)
    let spawned: SpawnedServer
    try {
      spawned = this.spawnDetached(plan, logFile)
    } catch (err) {
      return { ok: false, started: false, reason: '启动转换服务失败', detail: messageOf(err) }
    }

    const waitMs = this.deps.startWaitMs ?? MMD_START_WAIT_MS
    const pollMs = this.deps.startPollMs ?? MMD_START_POLL_MS
    const deadline = Date.now() + waitMs
    let last: MmdProbeResult | null = null
    while (Date.now() < deadline) {
      await this.sleep(pollMs)
      // 先看进程是不是已经退了：退出码能直接把原因说清楚，不用白等到超时
      const code = spawned.exitCode()
      if (code !== null) {
        return this.explainExit(code, logFile, plan)
      }
      last = await this.probe()
      if (last.ok) {
        return { ok: true, started: true, reason: '转换服务已启动', health: last.health }
      }
    }
    return {
      ok: false,
      started: true,
      reason: '转换服务启动了，但一直没就绪',
      detail: last && !last.ok ? last.reason : undefined
    }
  }

  /**
   * 退出码的含义是上游契约的一部分（接口协议 §2）。
   * 说法面向人：退出码只进日志，界面上说的是"哪里不对、下一步做什么"。
   */
  private explainExit(
    code: number,
    logFile: string | null,
    plan: Extract<MmdStartPlan, { ok: true }>
  ): MmdStartResultDto {
    if (code === 0) {
      // 已有本家且契约兼容的实例：它让位了，探测本应能通——交给调用方再探一次
      return {
        ok: false,
        started: false,
        reason: '这个端口上已经有一个转换服务在跑',
        detail: '点「测试连接」看它能不能用',
        exit_code: 0
      }
    }
    if (code === 3) {
      return {
        ok: false,
        started: false,
        reason: `端口 ${plan.port} 被别的程序占用了`,
        detail: '换一个端口再试，服务地址也要跟着改',
        exit_code: 3
      }
    }
    // 起不来时日志尾巴就是原因，截一行进回执（原件在日志里）
    const tail = logFile ? readLogTail(logFile, 1) : ''
    this.log(`[mmd] 转换服务启动失败，退出码 ${code}${logFile ? `，日志 ${logFile}` : ''}`)
    return {
      ok: false,
      started: false,
      reason: '转换服务没能启动',
      detail: tail === '' ? undefined : tail,
      exit_code: code
    }
  }

  private spawnDetached(
    plan: Extract<MmdStartPlan, { ok: true }>,
    logFile: string | null
  ): SpawnedServer {
    if (this.deps.spawnDetached) return this.deps.spawnDetached(plan, logFile)
    let fd: number | 'ignore' = 'ignore'
    if (logFile) {
      try {
        fd = openSync(logFile, 'a')
      } catch {
        fd = 'ignore'
      }
    }
    const child = spawn(plan.nodePath, plan.args, {
      cwd: plan.cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
      env: plan.electronAsNode ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
    })
    let code: number | null = null
    child.on('exit', (exitCode) => {
      code = exitCode
    })
    child.on('error', (err) => {
      code = -1
      this.log(`[mmd] 启动子进程出错：${messageOf(err)}`)
    })
    child.unref()
    if (typeof fd === 'number') {
      // 子进程持有这份 fd，父进程这份现在就可以关掉
      try {
        closeSync(fd)
      } catch {
        /* 关不上不影响运行 */
      }
    }
    return { pid: child.pid, exitCode: () => code }
  }

  // ---------- 转换 ----------

  /**
   * 一张图一次请求。**不抛异常**：单张失败与"服务整体不可用"都从返回值的 kind 上区分，
   * docx 库只认 `unavailable`，不认 HTTP 状态码与上游错误码。
   */
  async convert(text: string): Promise<MmdConvertResult> {
    const cfg = this.deps.getConfig()
    if (!cfg.enabled) {
      return { ok: false, kind: 'unavailable', code: 'disabled', message: '图转换已关闭' }
    }
    if (this.timeoutStreak >= MMD_TIMEOUT_STREAK_LIMIT) {
      return {
        ok: false,
        kind: 'unavailable',
        code: 'timeout_streak',
        message: `连续 ${this.timeoutStreak} 张转换超时，已停止本次转换`
      }
    }

    let retried = 0
    let revived = this.reviveAttempted
    for (let attempt = 0; attempt < 4; attempt++) {
      const result = await this.postConvert(cfg.endpoint, text)
      if (result.ok) {
        this.timeoutStreak = 0
        this.reviveAttempted = false
        return result
      }
      // 可重试类：退避一次。**注意别在这里记连续超时**——重试前的那次不算一张图
      if (retryable(result) && retried < 1) {
        retried += 1
        await this.sleep(this.deps.retryDelayMs ?? MMD_RETRY_DELAY_MS)
        continue
      }
      // 服务整体不可用：按配置点火一次，再试一次
      if (result.kind === 'unavailable' && !revived && cfg.auto_start) {
        revived = true
        this.reviveAttempted = true
        const started = await this.ensureRunning()
        if (started.ok) continue
        this.noteFinalFailure({ ...result, message: '转换服务不可用，重新启动也没起来' })
        return {
          ok: false,
          kind: 'unavailable',
          code: 'unreachable',
          message: '转换服务不可用，重新启动也没起来',
          hint: started.reason
        }
      }
      // 走到这里才是这张图的最终结果：连续超时只在这里记一笔
      const final: MmdConvertFailure = retried > 0 ? { ...result, retried: true } : result
      this.noteFinalFailure(final)
      return final
    }
    this.noteFinalFailure({ ok: false, kind: 'unavailable', code: 'unreachable', message: '转换服务反复失败，已停止本次转换' })
    return {
      ok: false,
      kind: 'unavailable',
      code: 'unreachable',
      message: '转换服务反复失败，已停止本次转换'
    }
  }

  /** 连续超时按"张"计数：成功或非超时的失败都会清零（服务答得出来就说明它没卡住） */
  private noteFinalFailure(result: MmdConvertFailure): void {
    if (result.code === 'timeout') this.timeoutStreak += 1
    else this.timeoutStreak = 0
  }

  private async postConvert(endpoint: string, text: string): Promise<MmdConvertResult> {
    const timeoutMs =
      this.deps.convertTimeoutMs ??
      ((this.lastHealth ? this.lastHealth.timeoutMs + MMD_CONVERT_TIMEOUT_SLACK_MS : MMD_CONVERT_TIMEOUT_MS) ||
        MMD_CONVERT_TIMEOUT_MS)
    let res: Response
    try {
      res = await this.fetchImpl(urlOf(endpoint, '/convert'), {
        method: 'POST',
        // 不给 Origin（给了会被 403）；charset 必须写 utf-8
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: text,
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (err) {
      const name = (err as { name?: string }).name
      if (name === 'TimeoutError' || name === 'AbortError') {
        return {
          ok: false,
          kind: 'single',
          code: 'timeout',
          message: `转换超时（${Math.round(timeoutMs / 1000)} 秒）`
        }
      }
      return {
        ok: false,
        kind: 'unavailable',
        code: 'unreachable',
        message: '连不上转换服务',
        hint: messageOf(err)
      }
    }

    if (res.ok) {
      try {
        const bytes = new Uint8Array(await res.arrayBuffer())
        const warnings = decodeWarnings(res.headers.get('x-mmd2vsdx-warnings'))
        if (warnings.length > 0) this.log(`[mmd] 转换提示：${warnings.join('；')}`)
        const sha256 = res.headers.get('x-mmd2vsdx-sha256')
        const kind = res.headers.get('x-mmd2vsdx-kind')
        const serviceVersion = res.headers.get('x-mmd2vsdx-version')
        return {
          ok: true,
          bytes,
          warnings,
          ...(sha256 ? { sha256 } : {}),
          ...(kind ? { kind } : {}),
          ...(serviceVersion ? { serviceVersion } : {})
        }
      } catch (err) {
        return {
          ok: false,
          kind: 'single',
          code: 'read_failed',
          message: '转换结果读不出来',
          hint: messageOf(err)
        }
      }
    }

    const info = await readErrorBody(res)
    return classifyHttp(res.status, info)
  }

  // ---------- 设置页看的状态 ----------

  /**
   * 设置页一次拿全：目录在不在、Node 找到哪个、探测通不通。
   * `override` 是表单现值：设置页改完还没点「保存设置」时，测的应当是眼前这一份，不是盘上那份。
   */
  async status(override?: MmdServiceConfig): Promise<MmdStatusDto> {
    const cfg = this.cfg(override)
    const serverEntry = cfg.dir === '' ? '' : join(cfg.dir, MMD_SERVER_ENTRY)
    let dirOk = false
    if (serverEntry !== '') {
      try {
        dirOk = statSync(serverEntry).isFile()
      } catch {
        dirOk = false
      }
    }
    const located = this.deps.locate
      ? await this.deps.locate(cfg.node_path)
      : await locateNode({ explicit: cfg.node_path, electronPath: this.deps.electronPath })
    const probe = await this.probe(override)
    return {
      enabled: cfg.enabled,
      endpoint: cfg.endpoint,
      dir: cfg.dir,
      dir_ok: dirOk,
      server_entry: serverEntry,
      node: located.picked ? toNodeDto(located.picked) : null,
      node_candidates: located.all.map(toNodeDto),
      probe: probe.ok
        ? { ok: true, kind: 'ok', reason: '转换服务可用', health: probe.health }
        : {
            ok: false,
            kind: probe.kind,
            reason: probe.reason,
            ...(probe.detail ? { detail: probe.detail } : {})
          }
    }
  }

  /** 供项目服务判断"这次导出能不能嵌入图表" */
  async available(cacheMs = 3000): Promise<boolean> {
    const probe = await this.probeCached(cacheMs)
    return probe.ok
  }
}

// ================= 纯函数 =================

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** endpoint + 路由；endpoint 末尾斜杠规整掉 */
export function urlOf(endpoint: string, route: string): string {
  return `${endpoint.trim().replace(/\/+$/, '')}${route}`
}

/** 解析服务地址；只认回环（上游只绑 127.0.0.1） */
export function parseEndpoint(endpoint: string): { host: string; port: number } | null {
  try {
    const url = new URL(endpoint.trim())
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
    if (!loopback) return null
    const port = url.port === '' ? 80 : Number(url.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    return { host, port }
  } catch {
    return null
  }
}

function parseHealth(body: unknown): MmdHealthDto | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b['ok'] !== true) return null
  const contractVersion = Number(b['contractVersion'])
  if (!Number.isFinite(contractVersion)) return null
  return {
    serviceVersion: String(b['serviceVersion'] ?? ''),
    contractVersion,
    chromium: String(b['chromium'] ?? 'unknown'),
    queue: Number(b['queue'] ?? 0),
    maxQueue: Number(b['maxQueue'] ?? 0),
    inFlight: Number(b['inFlight'] ?? 0),
    timeoutMs: Number(b['timeoutMs'] ?? 0),
    uptimeMs: Number(b['uptimeMs'] ?? 0),
    pid: Number(b['pid'] ?? 0)
  }
}

/** `Warnings` 是 base64 的 UTF-8 JSON 数组（HTTP 头只保证 ASCII） */
export function decodeWarnings(header: string | null): string[] {
  if (!header) return []
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

async function readErrorBody(res: Response): Promise<{ code?: string; message?: string; hint?: string }> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown; hint?: unknown } }
    const e = body?.error
    if (!e) return {}
    return {
      ...(typeof e.code === 'string' ? { code: e.code } : {}),
      ...(typeof e.message === 'string' ? { message: e.message } : {}),
      ...(typeof e.hint === 'string' ? { hint: e.hint } : {})
    }
  } catch {
    return {}
  }
}

function retryable(result: MmdConvertFailure): boolean {
  return result.code === 'queue_full' || result.code === 'timeout'
}

/** 状态码 → 我方动作（口径见上游接口协议 §6 与我方 PLAN §4） */
export function classifyHttp(
  status: number,
  info: { code?: string; message?: string; hint?: string }
): MmdConvertFailure {
  const code = info.code ?? `http_${status}`
  const message = info.message ?? `转换服务返回 HTTP ${status}`
  const base = { ...(info.hint ? { hint: info.hint } : {}) }
  switch (status) {
    // 单张的错：图本身的问题，继续下一张
    case 400:
    case 413:
    case 415:
    case 500:
      return { ok: false, kind: 'single', code, message, ...base }
    // 我方请求写错了：一张也发不出去，停手比逐张试到底清楚
    case 403:
      return { ok: false, kind: 'unavailable', code, message, ...base }
    // 可重试
    case 429:
    case 504:
      return { ok: false, kind: 'single', code, message, ...base }
    // 服务整体不可用
    case 503:
      return { ok: false, kind: 'unavailable', code, message, ...base }
    default:
      return { ok: false, kind: 'single', code, message, ...base }
  }
}

/** 读日志尾部：点火失败时最后的几行就是原因 */
export function readLogTail(file: string, lines: number): string {
  try {
    const text = readFileSync(file, 'utf8')
    const parts = text.split(/\r?\n/).filter((l) => l.trim() !== '')
    return parts.slice(-lines).join('\n')
  } catch {
    return ''
  }
}

function toNodeDto(probe: NodeProbe): MmdNodeProbeDto {
  return {
    path: probe.path,
    source: probe.source,
    version: probe.version,
    ok: probe.ok,
    ...(probe.reason ? { reason: probe.reason } : {}),
    ...(probe.electronAsNode === true ? { electron_as_node: true } : {})
  }
}
