/**
 * node-locate.ts — 找一个能跑 mmd2vsdx 服务端的 Node（上游 engines 要求 22.2 以上）。
 *
 * 为什么需要它：转换服务是个**外部件**，不在发行包里（合规边界，见 DESIGN-07），
 * 所以由用户提供目录与运行时。这里只负责"去哪找"，不做任何安装、不改 PATH。
 *
 * 顺序（先命中先用，全部候选都会跑一次 `--version` 留档，设置页要显示为什么没选上）：
 *   1. 设置里手填的路径（非空即最高优先，填错也不再往下找，免得"改了没反应"）
 *   2. PATH 上的 node
 *   3. %ProgramFiles%\nodejs\node.exe
 *   4. %LOCALAPPDATA%\Programs\nodejs\node.exe
 *   5. %NVM_SYMLINK% / %NVM_HOME% 下的 node.exe（nvm-windows）
 *   6. Electron 自带的 Node（要带 ELECTRON_RUN_AS_NODE=1 才当 node 用）——兜底，用户没装 Node 时用
 *
 * 注入 `exists` 与 `versionOf` 是为了单测能造出"哪个路径存在、报什么版本"而不用真的装 Node。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 上游 package.json 的 engines 要求 */
export const MIN_NODE_MAJOR = 22
export const MIN_NODE_MINOR = 2
export const MIN_NODE_TEXT = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`

export interface NodeCandidate {
  /** 可执行文件绝对路径 */
  path: string
  /** 来自哪条规则（设置页与诊断显示用） */
  source: string
  /** 是 Electron 自带的 Node：跑 `--version` 与起服务都要带 ELECTRON_RUN_AS_NODE=1 */
  electronAsNode?: boolean
}

export interface NodeProbe extends NodeCandidate {
  /** 形如 `22.23.1`；跑不起来是 null */
  version: string | null
  ok: boolean
  /** 没选上的一句话原因（给人看；达标时没有） */
  reason?: string
}

export interface LocateOptions {
  /** 设置里手填的路径 */
  explicit?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Electron 可执行文件；给了才有第 6 条兜底候选 */
  electronPath?: string
  exists?: (path: string) => boolean
  versionOf?: (candidate: NodeCandidate) => Promise<string | null>
}

/** 解析 `v22.23.1` / `22.23.1` 成 [22, 23, 1]；认不出来返回 null */
export function parseNodeVersion(text: string | null | undefined): number[] | null {
  if (!text) return null
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(text.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** 版本够不够跑上游（22.2 以上） */
export function satisfiesMinNode(version: string | null): boolean {
  const parsed = parseNodeVersion(version)
  if (!parsed) return false
  const [major, minor] = parsed as [number, number, number]
  if (major !== MIN_NODE_MAJOR) return major > MIN_NODE_MAJOR
  return minor >= MIN_NODE_MINOR
}

function isWindows(platform: NodeJS.Platform): boolean {
  return platform === 'win32'
}

/** 规整路径用于去重：Windows 大小写不敏感，两条规则常常指向同一个 node.exe */
function dedupeKey(path: string, platform: NodeJS.Platform): string {
  return isWindows(platform) ? path.toLowerCase() : path
}

/**
 * 按顺序列出候选。**只列不查**：存不存在、版本够不够，交给 `probeNode`。
 * 手填了路径就只留它一条——填错时应当明确报错，而不是悄悄换一个 Node 跑起来。
 */
export function nodeCandidates(options: LocateOptions = {}): NodeCandidate[] {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const win = isWindows(platform)
  const exeName = win ? 'node.exe' : 'node'
  const out: NodeCandidate[] = []
  const seen = new Set<string>()
  const push = (candidate: NodeCandidate): void => {
    const key = dedupeKey(candidate.path, platform)
    if (seen.has(key)) return
    seen.add(key)
    out.push(candidate)
  }

  const explicit = (options.explicit ?? '').trim()
  if (explicit !== '') {
    push({ path: explicit, source: '设置里指定的' })
    return out
  }

  for (const dir of (env['PATH'] ?? '').split(win ? ';' : ':')) {
    const trimmed = dir.trim().replace(/^"|"$/g, '')
    if (trimmed === '') continue
    // PATH 里可能直接写着 node.exe 的全路径，也可能是一个目录
    push({
      path: /\.exe$/i.test(trimmed) || trimmed.endsWith(`/${exeName}`)
        ? trimmed
        : join(trimmed, exeName),
      source: 'PATH'
    })
  }

  if (win) {
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
    const localAppData = env['LOCALAPPDATA'] ?? ''
    const nvmSymlink = env['NVM_SYMLINK'] ?? ''
    const nvmHome = env['NVM_HOME'] ?? ''
    push({ path: join(programFiles, 'nodejs', 'node.exe'), source: 'Program Files' })
    if (localAppData !== '') {
      push({ path: join(localAppData, 'Programs', 'nodejs', 'node.exe'), source: 'LocalAppData' })
    }
    if (nvmSymlink !== '') push({ path: join(nvmSymlink, 'node.exe'), source: 'NVM_SYMLINK' })
    if (nvmHome !== '') push({ path: join(nvmHome, 'node.exe'), source: 'NVM_HOME' })
  } else {
    push({ path: '/usr/local/bin/node', source: '常见安装位置' })
    push({ path: '/usr/bin/node', source: '常见安装位置' })
  }

  const electronPath = (options.electronPath ?? '').trim()
  if (electronPath !== '') {
    push({ path: electronPath, source: '应用自带的 Node', electronAsNode: true })
  }

  return out
}

/** 跑一次 `--version`；跑不起来返回 null（超时、不是 Node、权限不足都归这一档） */
export function defaultNodeVersionOf(candidate: NodeCandidate): Promise<string | null> {
  return new Promise((resolve) => {
    const env = candidate.electronAsNode
      ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      : process.env
    execFile(
      candidate.path,
      ['--version'],
      { timeout: 5000, windowsHide: true, env },
      (err, stdout) => {
        if (err && !stdout) {
          resolve(null)
          return
        }
        const m = /v?\d+\.\d+\.\d+/.exec(String(stdout))
        // 去掉 `v` 前缀：界面上写「运行环境 22.23.1」比「v22.23.1」顺眼
        resolve(m ? m[0].replace(/^v/, '') : null)
      }
    )
  })
}

/** 查一个候选：在不在、跑不跑得起来、版本够不够 */
export async function probeNode(
  candidate: NodeCandidate,
  options: Pick<LocateOptions, 'exists' | 'versionOf'> = {}
): Promise<NodeProbe> {
  const exists = options.exists ?? existsSync
  const versionOf = options.versionOf ?? defaultNodeVersionOf
  if (!exists(candidate.path)) {
    return { ...candidate, version: null, ok: false, reason: '文件不存在' }
  }
  const version = await versionOf(candidate)
  if (version === null) {
    return { ...candidate, version: null, ok: false, reason: '跑不起来，可能不是可执行文件或者权限不足' }
  }
  if (!satisfiesMinNode(version)) {
    return { ...candidate, version, ok: false, reason: `版本 ${version} 低于要求的 ${MIN_NODE_TEXT}` }
  }
  return { ...candidate, version, ok: true }
}

export interface LocateResult {
  /** 选中的那个（没有就是 null） */
  picked: NodeProbe | null
  /** 全部候选的探查结果，按顺序；设置页与诊断用它解释"为什么没找到" */
  all: NodeProbe[]
}

/** 顺序试候选，返回第一个达标的；全部探查结果一并带回 */
export async function locateNode(options: LocateOptions = {}): Promise<LocateResult> {
  const all: NodeProbe[] = []
  for (const candidate of nodeCandidates(options)) {
    const probe = await probeNode(candidate, options)
    all.push(probe)
    if (probe.ok) return { picked: probe, all }
  }
  return { picked: null, all }
}
