/**
 * visio-locate.ts — 找本机的 Visio（主进程）。**只查不改**：不启动 Visio、不碰用户的文档。
 *
 * 为什么要有这一节：嵌入 vsdx 时，连线端点与走线由生成侧"复刻"Visio 的求解结果，
 * 11/24 个端点会落在目标形状的另一个轴上（差半宽 0.4115in / 半高 0.1875in）⇒ Word 首帧偏移 ✗。
 * 让 Visio 自己重存一次就从"复刻"变成"取真值"，详见 docs/WORD处理经验/10。
 *
 * 本文件只负责**回答"这台机器上有没有 Visio、在哪、什么版本"**（快速档：查注册表，毫秒级）；
 * 真正调 COM 的地方在 visio-service.ts。探测失败一律返回 found:false + 原因，不抛。
 *
 * 查法与 mmd2vsdx 那节同一套形态：候选列表 + 每个候选的来源/版本/为什么没用上，
 * 设置页直接把这份结论摆出来（用户不用猜为什么没生效）。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { VisioCandidateDto, VisioConfigDto, VisioStatusDto } from '../../shared/project'

/** 应用设置里「Visio（可选）」一节的默认值：检测到就用，用户可关 */
export const DEFAULT_VISIO_CONFIG: VisioConfigDto = {
  enabled: true,
  exe_path: '',
  prog_id: 'Visio.Application',
  // 整篇一次会话：实测启动约 1.2s + 每张约 1.8s，23 张约 42s，给到 3 分钟留足余量
  timeout_ms: 180000
}

export function normalizeVisioConfig(raw: unknown): VisioConfigDto {
  const r = (raw ?? {}) as Partial<VisioConfigDto>
  const timeout = Number(r.timeout_ms)
  return {
    enabled: r.enabled !== false,
    exe_path: typeof r.exe_path === 'string' ? r.exe_path.trim() : '',
    prog_id: typeof r.prog_id === 'string' && r.prog_id.trim() !== '' ? r.prog_id.trim() : DEFAULT_VISIO_CONFIG.prog_id,
    // 上限给足（大图整篇重存慢），下限别让用户把自己坑了
    timeout_ms: Number.isFinite(timeout) ? Math.min(600000, Math.max(5000, Math.round(timeout))) : DEFAULT_VISIO_CONFIG.timeout_ms
  }
}

/**
 * 一次性把"装没装、装在哪、什么版本"问清楚。
 *
 * 为什么走 PowerShell：注册表在 Node 侧没有免原生依赖的读法，而 `reg.exe` 拿不到文件版本与位数；
 * 一次 PowerShell（约 150~400ms）把三件事一起问完，比连开三个进程便宜。
 * 这一档**不启动 Visio**（那是 visio-service 的"深度检测"）。
 */
const PROBE_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$out = [ordered]@{ registered = $false; clsid = $null; installs = @() }',
  '$cls = (Get-ItemProperty "HKLM:\\SOFTWARE\\Classes\\Visio.Application\\CLSID")."(default)"',
  'if ($cls) { $out.registered = $true; $out.clsid = $cls }',
  'foreach ($v in (Get-ChildItem "HKLM:\\SOFTWARE\\Microsoft\\Office").PSChildName) {',
  '  if ($v -notmatch "^\\d+\\.\\d+$") { continue }',
  '  $root = (Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Office\\$v\\Visio\\InstallRoot").Path',
  '  if (-not $root) { continue }',
  '  $exe = Join-Path $root "VISIO.EXE"',
  '  $ver = $null; $exists = Test-Path $exe',
  '  if ($exists) { $ver = (Get-Item $exe).VersionInfo.FileVersion }',
  '  $out.installs += [ordered]@{ office = $v; root = $root; exe = $exe; exists = $exists; version = $ver }',
  '}',
  '$out | ConvertTo-Json -Compress -Depth 5'
].join('\n')

export interface RawProbe {
  registered?: boolean
  clsid?: string | null
  installs?: Array<{ office?: string; root?: string; exe?: string; exists?: boolean; version?: string | null }>
}

function runProbe(timeoutMs: number): Promise<RawProbe> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROBE_SCRIPT],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) {
          reject(err)
          return
        }
        try {
          resolve(JSON.parse(String(stdout).trim()) as RawProbe)
        } catch {
          reject(new Error('探测输出不是 JSON'))
        }
      }
    )
  })
}

/** 位数只能从安装根判断：x86 的 Office 装在 Program Files (x86) 下 */
function bitnessOf(root: string): string | null {
  const lower = root.toLowerCase()
  if (lower.includes('program files (x86)')) return 'x86'
  if (lower.includes('program files')) return 'x64'
  return null
}

/**
 * 把探测原始结果翻成设置页要的现状（纯函数，便于单测）。
 * 判定口径：**能定位到一份存在的 VISIO.EXE 才算 found** —— 只有 COM 注册残留不算，
 * 否则会走进"以为能归一化、实际起不来"的坑。
 */
export function statusFromProbe(raw: RawProbe, ms: number): VisioStatusDto {
  const candidates: VisioCandidateDto[] = []
  for (const inst of raw.installs ?? []) {
    const root = String(inst.root ?? '')
    const exe = String(inst.exe ?? join(root, 'VISIO.EXE'))
    const exists = inst.exists === true || existsSync(exe)
    candidates.push({
      path: exe,
      source: `注册表 Office ${inst.office ?? '?'} 安装根`,
      version: inst.version ?? null,
      bitness: bitnessOf(root),
      ok: exists,
      reason: exists ? undefined : '安装根下没有 VISIO.EXE'
    })
  }
  if (candidates.length === 0 && raw.registered) {
    candidates.push({
      path: '',
      source: 'COM 已注册',
      version: null,
      bitness: null,
      ok: false,
      reason: '注册表里没有 Visio 安装根，可能是其它产品留下的注册'
    })
  }

  const best = candidates.find((c) => c.ok) ?? null
  return {
    found: best !== null,
    registered: raw.registered === true,
    source: best ? best.source : candidates.length > 0 ? candidates[0]!.source : '注册表里没有 Visio',
    exe: best ? best.path : null,
    version: best ? best.version : null,
    bitness: best ? best.bitness : null,
    candidates,
    probe: best
      ? { ok: true, reason: '检测到 Visio', ms }
      : {
          ok: false,
          reason: raw.registered ? 'COM 已注册但找不到安装根' : '本机没有 Visio',
          detail: candidates.map((c) => `${c.source}：${c.reason ?? 'ok'}`).join('；') || undefined,
          ms
        }
  }
}

/** 探测结果缓存：设置页进进出出不该每次都开进程 */
let cached: { at: number; status: VisioStatusDto } | null = null
const CACHE_MS = 60_000

/**
 * 快速检测（查注册表，毫秒级）。
 * `force` 传 true 表示忽略缓存（设置页的「重新检测」）。
 */
export async function probeVisio(force = false): Promise<VisioStatusDto> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.status
  const started = Date.now()
  let status: VisioStatusDto
  try {
    status = statusFromProbe(await runProbe(8000), Date.now() - started)
  } catch (err) {
    status = {
      found: false,
      registered: false,
      source: '探测失败',
      exe: null,
      version: null,
      bitness: null,
      candidates: [],
      probe: {
        ok: false,
        reason: '查不到 Visio 的注册信息',
        detail: err instanceof Error ? err.message : String(err),
        ms: Date.now() - started
      }
    }
  }
  cached = { at: Date.now(), status }
  return status
}

/** 测试用：清掉缓存 */
export function resetVisioProbeCache(): void {
  cached = null
}
