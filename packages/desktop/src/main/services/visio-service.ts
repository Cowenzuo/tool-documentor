/**
 * visio-service.ts — Visio（可选加速器）的调用层（主进程）。
 *
 * 干什么：把一批 vsdx 交给一次 Visio 会话（scripts/visio-normalize.ps1），
 * 拿回 ① Visio 重存后的 vsdx（走线/端点由 Visio 自己算）② 按页面尺寸导出的预览 EMF。
 * 没有 Visio、调用失败、超时 —— 一律**逐张回退**到内置方案（自产预览 + 原始 vsdx），
 * 绝不让导出因为 Visio 挂掉。口径见 docs/WORD处理经验/10。
 *
 * 三条设计约束：
 *   1. **一导出一次会话**：批量交给一个 PowerShell 进程，别每张图起一次 Visio（启动就 1 秒级）；
 *   2. **结果按内容缓存**：同一个 vsdx 不重复过 Visio（缓存键含脚本版本与 Visio 版本，换版本自动失效）；
 *   3. **本文件不 import electron**：缓存目录由调用方给，这样纯 Node 也能跑（便于本机验证与单测）。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VisioConfigDto } from '../../shared/project'

/** 脚本版本：脚本文件读不到时的兜底（正常路径用脚本内容哈希进缓存键，见 cacheKeyFor） */
export const VISIO_SCRIPT_VERSION_FALLBACK = 1

/** PowerShell 输出上限：清单回执很小，给 4MB 足够，别让异常输出把内存撑爆 */
const MAX_STDOUT_BYTES = 1 << 22

/** 孤儿判定的最小年龄：比单批上限（配置最大 600s）还久才认定是"上一次被强杀留下的" */
const ORPHAN_MIN_AGE_MS = 15 * 60_000

/** 缓存上限：条数 + 总字节（超了按最旧先删） */
const CACHE_MAX_ENTRIES = 500
const CACHE_MAX_BYTES = 200 * 1024 * 1024

export interface VisioNormalizeInput {
  id: string
  vsdx: Uint8Array
}

export interface VisioNormalizeResult {
  id: string
  ok: boolean
  /** 归一化后的 vsdx（Visio 重存态） */
  vsdx?: Uint8Array
  /** Visio 按页面尺寸导出的预览 EMF（不是 vsdx 自带的缩略图） */
  previewEmf?: Uint8Array
  /** 失败原因（进日志与警告，不上界面当错误） */
  reason?: string
  /** 本次是否命中缓存 */
  cached?: boolean
}

export interface VisioServiceOptions {
  /** 缓存目录（主进程传 app.getPath('userData')/visio-cache） */
  cacheDir: string
  /** 脚本路径（打包后随 resources 走） */
  scriptPath: string
  /** 现读配置（enabled / timeout_ms / prog_id） */
  config: () => VisioConfigDto
  /** 本机 Visio 版本（进缓存键；拿不到传 null） */
  visioVersion?: () => string | null
}

/**
 * 缓存键：内容 + 脚本内容哈希 + Visio 版本（任一变化就重算）。
 *
 * 为什么用脚本**内容哈希**而不是手工版本号：手工号靠人记得加一，忘了就复用旧结果 ——
 * 这类"改了没生效"的坑在本项目已经踩过（dist 落后一分钟那次）。
 */
export function cacheKeyFor(vsdx: Uint8Array, visioVersion: string | null, scriptHash: string): string {
  const h = createHash('sha256').update(vsdx).digest('hex').slice(0, 32)
  const v = (visioVersion ?? 'unknown').replace(/[^\w.-]/g, '_')
  return `${h}-s${scriptHash}-v${v}`
}

/** 读脚本内容哈希（读不到返回兜底版本号，仍然能跑，只是失效粒度变粗） */
export function scriptHashOf(scriptPath: string): string {
  try {
    return createHash('sha256').update(readFileSync(scriptPath)).digest('hex').slice(0, 12)
  } catch {
    return `v${VISIO_SCRIPT_VERSION_FALLBACK}`
  }
}

/**
 * 找出"上一次被强杀留下的" pid 记录（纯函数，便于单测）。
 *
 * 场景：应用被强杀时，脚本里的收尾和 Node 侧的兜底都随进程死亡而失效，Visio 会变孤儿
 * （2026-09-29 实测遇到一次）。这里只认**我们自己写下的** pid 文件，且只认足够旧的目录，
 * 免得把正在跑的那一批误杀。
 */
export function stalePidFiles(tmpDir: string, now: number, minAgeMs: number = ORPHAN_MIN_AGE_MS): Array<{ dir: string; pidFile: string }> {
  const out: Array<{ dir: string; pidFile: string }> = []
  let entries: string[]
  try {
    entries = readdirSync(tmpDir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (!name.startsWith('doc-visio-')) continue
    const dir = join(tmpDir, name)
    const pidFile = join(dir, 'visio.pid')
    try {
      const st = statSync(pidFile)
      if (now - st.mtimeMs < minAgeMs) continue
      out.push({ dir, pidFile })
    } catch {
      // 没有 pid 文件的目录：只清理目录本身，不动进程
      try {
        const st = statSync(dir)
        if (now - st.mtimeMs >= minAgeMs) out.push({ dir, pidFile: '' })
      } catch {
        // 目录已经没了
      }
    }
  }
  return out
}

/** 清掉孤儿 Visio（按我们自己记录的 PID）并删除陈旧临时目录；返回清掉的进程数 */
export function sweepOrphanVisio(tmpDir: string = tmpdir(), now: number = Date.now()): number {
  let killed = 0
  for (const { dir, pidFile } of stalePidFiles(tmpDir, now)) {
    if (pidFile !== '') {
      const alive = killPidIfAlive(pidFile)
      if (alive) killed += 1
    }
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 删不掉就留着，下一轮再说
    }
  }
  return killed
}

/** 清单形状（脚本按它逐张处理） */
export interface VisioManifestItem {
  id: string
  in: string
  outVsdx: string
  outEmf: string
}

/**
 * 按脚本留下的 PID 文件兜底清理（纯函数：读文件 + 杀进程，失败一律吞掉）。
 *
 * 为什么需要它：PowerShell 被 execFile 的超时强杀时，脚本里的 finally 不会执行，
 * 那个隐藏的 VISIO.EXE 就成了孤儿 —— 2026-09-29 用户就是这么看到的残留。
 */
export function killPidIfAlive(pidFile: string): boolean {
  try {
    if (!existsSync(pidFile)) return false
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    if (!Number.isInteger(pid) || pid <= 0) return false
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    if (alive) process.kill(pid)
    return alive
  } catch {
    return false
  } finally {
    try {
      rmSync(pidFile, { force: true })
    } catch {
      // 删不掉就算了：临时目录随后整体清理
    }
  }
}

/** 脚本回执（stdout 单行 JSON） */
export interface RawVisioResult {
  id?: string
  ok?: boolean
  reason?: string
}

/**
 * 解析脚本回执（纯函数，便于单测）。
 * 脚本正常时输出单个 JSON 数组；数组里也可能只有一条，所以两种都认。
 */
export function parseScriptResults(stdout: string): RawVisioResult[] {
  const text = stdout.trim()
  const start = text.indexOf('[')
  if (start < 0) return []
  try {
    const parsed = JSON.parse(text.slice(start)) as RawVisioResult | RawVisioResult[]
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

export class VisioService {
  /** 显式字段而不是构造器参数属性：这样本文件能被 `node --experimental-strip-types` 直接跑（本机验证用） */
  private readonly opts: VisioServiceOptions

  constructor(opts: VisioServiceOptions) {
    this.opts = opts
  }

  private get enabled(): boolean {
    return this.opts.config().enabled
  }

  /** 是否启用（导出链路先问这个，避免白起一次 Visio） */
  isEnabled(): boolean {
    return this.enabled
  }

  private scriptHashMemo: string | null = null

  /** 脚本内容哈希（进缓存键；读一次记住） */
  private scriptHash(): string {
    if (this.scriptHashMemo === null) this.scriptHashMemo = scriptHashOf(this.opts.scriptPath)
    return this.scriptHashMemo
  }

  /**
   * 批量归一化。返回顺序与入参一致；失败项 `ok:false`（调用方按张回退）。
   * 命中缓存的项直接返回缓存件（不进 Visio）。
   */
  async normalizeBatch(items: VisioNormalizeInput[]): Promise<VisioNormalizeResult[]> {
    if (items.length === 0) return []
    // 启用判定在这里再判一次是**库边界自守**（调用方也判，别删成一层）：
    // 这个类将来可能被别处复用，谁都不想"以为没启用，结果起了一次 Visio"。
    if (!this.enabled) return items.map((i) => ({ id: i.id, ok: false, reason: 'Visio 归一化未启用' }))
    // 开跑前扫一次：上一次被强杀留下的孤儿（我们自己记过 PID 的）先清掉，别越积越多
    try {
      sweepOrphanVisio()
    } catch {
      // 清扫失败不影响本次
    }

    const version = this.opts.visioVersion?.() ?? null
    const out = new Map<string, VisioNormalizeResult>()
    const pending: VisioNormalizeInput[] = []
    for (const item of items) {
      const hit = this.readCache(item, version)
      if (hit) out.set(item.id, hit)
      else pending.push(item)
    }
    if (pending.length > 0) {
      const fresh = await this.runScript(pending, version)
      for (const r of fresh) out.set(r.id, r)
      this.enforceCacheLimit()
    }
    return items.map((i) => out.get(i.id) ?? { id: i.id, ok: false, reason: '没有拿到结果' })
  }

  /** 缓存上限：条数或总字节超了就按最旧先删（缓存是可再生的，删错也只是慢一次） */
  private enforceCacheLimit(): void {
    try {
      const files = readdirSync(this.opts.cacheDir)
        .map((name) => {
          const p = join(this.opts.cacheDir, name)
          try {
            const st = statSync(p)
            return st.isFile() ? { p, size: st.size, at: st.mtimeMs } : null
          } catch {
            return null
          }
        })
        .filter((x): x is { p: string; size: number; at: number } => x !== null)
        .sort((a, b) => a.at - b.at)
      const totalBytes = files.reduce((s, f) => s + f.size, 0)
      let count = files.length
      let bytes = totalBytes
      for (const f of files) {
        if (count <= CACHE_MAX_ENTRIES && bytes <= CACHE_MAX_BYTES) break
        rmSync(f.p, { force: true })
        count -= 1
        bytes -= f.size
      }
    } catch {
      // 缓存清理失败不影响本次结果
    }
  }

  private cachePaths(key: string): { vsdx: string; emf: string; meta: string } {
    const base = join(this.opts.cacheDir, key)
    return { vsdx: `${base}.vsdx`, emf: `${base}.emf`, meta: `${base}.json` }
  }

  private readCache(item: VisioNormalizeInput, version: string | null): VisioNormalizeResult | null {
    try {
      const p = this.cachePaths(cacheKeyFor(item.vsdx, version, this.scriptHash()))
      if (!existsSync(p.vsdx)) return null
      const meta = existsSync(p.meta) ? (JSON.parse(readFileSync(p.meta, 'utf8')) as { emf?: boolean }) : {}
      return {
        id: item.id,
        ok: true,
        cached: true,
        vsdx: new Uint8Array(readFileSync(p.vsdx)),
        previewEmf: meta.emf && existsSync(p.emf) ? new Uint8Array(readFileSync(p.emf)) : undefined
      }
    } catch {
      return null
    }
  }

  private writeCache(item: VisioNormalizeInput, version: string | null, r: VisioNormalizeResult): void {
    try {
      mkdirSync(this.opts.cacheDir, { recursive: true })
      const p = this.cachePaths(cacheKeyFor(item.vsdx, version, this.scriptHash()))
      if (r.vsdx) writeFileSync(p.vsdx, r.vsdx)
      if (r.previewEmf) writeFileSync(p.emf, r.previewEmf)
      writeFileSync(p.meta, JSON.stringify({ emf: Boolean(r.previewEmf), script: this.scriptHash(), visio: version }), 'utf8')
    } catch {
      // 缓存写不进去不影响本次结果
    }
  }

  /** 真正调 Visio：临时目录 + 清单 + 一次 PowerShell；超时强杀 */
  private runScript(items: VisioNormalizeInput[], version: string | null): Promise<VisioNormalizeResult[]> {
    const cfg = this.opts.config()
    const dir = mkdtempSync(join(tmpdir(), 'doc-visio-'))
    /** 清理只能放在回调里：execFile 是异步的，finally 会在子进程还没起来时就删掉清单 ✗ */
    const cleanup = (): void => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // 清理失败不影响结果
      }
    }
    const allFailed = (reason: string): VisioNormalizeResult[] => items.map((i) => ({ id: i.id, ok: false, reason }))

    // 脚本找不到要**显式**报出来：否则就会变成"以为归一化了、其实原样嵌入"这种最难查的状态
    if (!existsSync(this.opts.scriptPath)) {
      cleanup()
      return Promise.resolve(allFailed(`找不到 Visio 归一化脚本：${this.opts.scriptPath}`))
    }

    let manifestPath = ''
    const pidFile = join(dir, 'visio.pid')
    try {
      const manifest: VisioManifestItem[] = items.map((item, i) => {
        const inPath = join(dir, `in${i}.vsdx`)
        writeFileSync(inPath, item.vsdx)
        return { id: item.id, in: inPath, outVsdx: join(dir, `out${i}.vsdx`), outEmf: join(dir, `out${i}.emf`) }
      })
      manifestPath = join(dir, 'manifest.json')
      writeFileSync(manifestPath, JSON.stringify({ items: manifest }), 'utf8')
    } catch (e) {
      cleanup()
      return Promise.resolve(allFailed(`准备 Visio 输入失败：${e instanceof Error ? e.message : String(e)}`))
    }

    return new Promise<VisioNormalizeResult[]>((resolve) => {
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.opts.scriptPath,
          '-Manifest',
          manifestPath,
          // 脚本会把 Visio 的 PID 写在这里：脚本自己被超时杀掉时，靠它兜底清掉 Visio
          '-PidFile',
          pidFile
        ],
        { timeout: cfg.timeout_ms, windowsHide: true, maxBuffer: 1 << 22 },
        (err, stdout, stderr) => {
          try {
            const raw = parseScriptResults(String(stdout ?? ''))
            const byId = new Map(raw.map((r) => [String(r.id), r]))
            const results: VisioNormalizeResult[] = items.map((item, i) => {
              const r = byId.get(item.id)
              if (err && !r) {
                return { id: item.id, ok: false, reason: `Visio 调用失败：${err.message}${stderr ? ` · ${String(stderr).trim().slice(0, 200)}` : ''}` }
              }
              if (!r || r.ok !== true) return { id: item.id, ok: false, reason: r?.reason ?? 'Visio 处理失败' }
              try {
                const vsdx = new Uint8Array(readFileSync(join(dir, `out${i}.vsdx`)))
                const emfPath = join(dir, `out${i}.emf`)
                const previewEmf = existsSync(emfPath) ? new Uint8Array(readFileSync(emfPath)) : undefined
                const ok: VisioNormalizeResult = { id: item.id, ok: true, vsdx, previewEmf }
                this.writeCache(item, version, ok)
                return ok
              } catch (e) {
                return { id: item.id, ok: false, reason: `读不出 Visio 产出：${e instanceof Error ? e.message : String(e)}` }
              }
            })
            resolve(results)
          } finally {
            // 超时/异常时 PowerShell 会被杀，脚本里的收尾跑不到 ⇒ 这里按 PID 兜底，别留隐藏的 VISIO.EXE
            killPidIfAlive(pidFile)
            cleanup()
          }
        }
      )
    })
  }
}
