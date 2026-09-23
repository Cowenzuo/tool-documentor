/**
 * 设置对话框：主题、默认工程目录、模板目录列表（增删/浏览；保存后主进程即时重载模板）、
 * 图转换服务（mmd2vsdx）。
 * 每个模板目录就地显示加载结果——配错一层目录时，这里要说清为什么没加载到。
 * 「模板目录」一节只管配置：增删目录、看每个目录加载到什么。
 * 「转换服务」一节只管配置与连通性：它是个外部件，本软件**不接管它的生命周期**——
 * 只探测、按需点火（启动后立刻撒手），没有「停止服务」。
 * 模板编辑的入口不在这里——它在欢迎页（与新建/打开工程并排），那里不打开工程也能进。
 */
import { useEffect, useRef, useState } from 'react'
import type { AppConfigDto, MmdStatusDto, TemplateLoadReport } from '../../../shared/project'
import { useApp } from '../state/AppContext'
import { useTheme, type ThemePreference } from '../theme/ThemeProvider'
import { errorText } from '../utils/errorText'

/** 主题三选项：顺序与标题栏原先的循环顺序一致 */
const THEME_OPTIONS: Array<{ value: ThemePreference; label: string }> = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' }
]

function ThemeSection(): React.JSX.Element {
  const { preference, setPreference } = useTheme()
  return (
    <section className="settings-group">
      <h3>主题</h3>
      <div className="settings-seg" role="group" aria-label="主题">
        {THEME_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={preference === option.value ? 'active' : ''}
            aria-pressed={preference === option.value}
            onClick={() => setPreference(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </section>
  )
}

/**
 * 图转换服务（mmd2vsdx）一节。
 *
 * 排法照设置页的既有口径：**一行配置 + 紧跟一条就地状态**（范本是「模板目录」那节），
 * 长解释一律进悬停提示，不占版面。三处自己的样子：
 *   - **进设置就自动探一次**，不用先点「测试连接」才看得到现状；
 *   - 运行环境查到什么**显示在标题右边**（只写版本号），字段本身是可手填的路径 + 浏览；
 *   - 地址、端口、「默认拉起」同处一行。
 *
 * 四条边界：
 *   1. **没有"要不要转"这一档**：流程图转成可编辑对象是固有能力，有图就走这条路，
 *      服务不可用就自动按文本导出并如实告知（DESIGN-07 第 1 节那条口径）。
 *      这一节配的只是"去哪找它"，所以没有开关；
 *   2. 它是**外部件**（不进发行包），运行环境、目录、地址都得用户给，缺哪样就地一句话说清；
 *   3. 「测试连接」「启动服务」拿的是**表单现值、不写盘**——没点「保存设置」就等于没配，
 *      所以「取消」仍然是取消；
 *   4. 只有「启动服务」，没有「停止服务」：服务不归本软件管，上游也没提供关机接口。
 *
 * 文案：每条最多一句；驱动给的原始异常（`fetch failed` 这类）不上界面，进日志。
 */
function MmdSection({
  cfg,
  onChange
}: {
  cfg: AppConfigDto
  onChange: (next: AppConfigDto) => void
}): React.JSX.Element {
  const { showToast } = useApp()
  const mmd = cfg.mmd2vsdx
  const [status, setStatus] = useState<MmdStatusDto | null>(null)
  const [busy, setBusy] = useState<'test' | 'start' | null>(null)
  /** 端口用文本存：允许用户敲到一半（清空、删一位），合法的中间态才写回配置 */
  const [portText, setPortText] = useState(String(mmd.port))
  const refreshTimer = useRef<number | null>(null)
  /** 最新一份配置：防抖回调落地时闭包里的 cfg 已经过期，写回要拿它算 */
  const latest = useRef(cfg)
  useEffect(() => {
    latest.current = cfg
  })

  const patch = (part: Partial<AppConfigDto['mmd2vsdx']>): void => {
    const prev = latest.current
    onChange({ ...prev, mmd2vsdx: { ...prev.mmd2vsdx, ...part } })
  }

  /** 把探到的运行环境填回去：只在还没手填过（字段为空）时填，免得覆盖用户自己挑的 */
  const fillNodePath = (next: MmdStatusDto): void => {
    if (!next.node) return
    const prev = latest.current
    if (prev.mmd2vsdx.node_path.trim() !== '') return
    onChange({ ...prev, mmd2vsdx: { ...prev.mmd2vsdx, node_path: next.node.path } })
  }

  /** 探一次并把结论摆出来（标题右边的版本、目录那颗灯、服务通不通都从这儿来） */
  const refresh = async (config: AppConfigDto['mmd2vsdx']): Promise<void> => {
    const next = await window.documentor.mmd.status(config)
    setStatus(next)
    fillNodePath(next)
  }

  /**
   * 改了字段**自动重探一次**（防抖）：现状本来就该自己跟上，不能指望用户去点「测试连接」。
   * 先把结论清掉，免得旧结论留在界面上骗人。
   */
  const patchConnection = (part: Partial<AppConfigDto['mmd2vsdx']>): void => {
    const prev = latest.current
    const next = { ...prev.mmd2vsdx, ...part }
    onChange({ ...prev, mmd2vsdx: next })
    setStatus(null)
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null
      void refresh(next).catch(() => undefined)
    }, 350)
  }

  // 进设置就探一次：现状（运行环境、目录、服务通不通）不该等用户点了才出现
  useEffect(() => {
    void window.documentor.mmd
      .status(mmd)
      .then((next) => {
        setStatus(next)
        fillNodePath(next)
      })
      .catch(() => undefined)
    return () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current)
    }
    // 只在挂载时来一次；之后由字段变更与两颗按钮驱动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const test = async (): Promise<void> => {
    setBusy('test')
    try {
      await refresh(mmd)
    } catch (err) {
      showToast({ kind: 'error', text: `连接失败：${errorText(err)}` })
    } finally {
      setBusy(null)
    }
  }

  /**
   * 启动前**先确认在不在跑**：真的没在跑才点火（这一步在主进程里也是这么做的，
   * 界面这边只是把结论说出来，并且已经在跑时不让点）。
   */
  const start = async (): Promise<void> => {
    setBusy('start')
    try {
      const result = await window.documentor.mmd.start(mmd)
      const text = result.detail ? `${result.reason}：${result.detail}` : result.reason
      showToast({ kind: result.ok ? 'info' : 'error', text })
      await refresh(mmd)
    } catch (err) {
      showToast({ kind: 'error', text: `启动失败：${errorText(err)}` })
    } finally {
      setBusy(null)
    }
  }

  const onPort = (value: string): void => {
    setPortText(value)
    const n = Number(value.trim())
    if (/^\d+$/.test(value.trim()) && n > 0 && n <= 65535) patchConnection({ port: n })
    else setStatus(null)
  }
  /** 标题右边那块：当前运行环境查到的是哪个版本；没有就说"未找到"，原因进悬停 */
  const nodeState = ((): { text: string; bad: boolean; why: string } | null => {
    if (!status) return null
    if (status.node) return { text: status.node.version ?? '', bad: false, why: status.node.path }
    if (mmd.node_path.trim() !== '') {
      const why = status.node_candidates[0]?.reason ?? ''
      return { text: '不可用', bad: true, why }
    }
    return { text: '未找到', bad: true, why: '没找到可用的运行环境（需要 22.2 以上）' }
  })()

  const dirState = ((): { bad: boolean; why: string } | null => {
    if (!status || mmd.dir.trim() === '') return null
    return status.dir_ok
      ? { bad: false, why: '这个目录里有服务程序' }
      : { bad: true, why: '这个目录里没有服务程序' }
  })()
  const serviceLine = ((): { text: string; bad: boolean } | null => {
    if (!status) return null
    if (status.probe.ok && status.probe.health) {
      return { text: `服务可用 · ${status.probe.health.serviceVersion}`, bad: false }
    }
    return { text: status.probe.reason, bad: true }
  })()

  const line = (value: { text: string; bad: boolean } | null): React.JSX.Element | null =>
    value === null ? null : (
      <p className={`settings-status${value.bad ? ' bad' : ''}`}>{value.text}</p>
    )

  /** 就地状态灯：绿=就位、红=有问题。理由进悬停，不占版面、不另开一行 */
  const light = (value: { bad: boolean; why: string } | null): React.JSX.Element | null =>
    value === null ? null : (
      <i className={`settings-light${value.bad ? ' bad' : ''}`} title={value.why} />
    )

  /** 已经确认在跑就别再让人点「启动服务」；没探过则允许点，主进程那边会先探再决定 */
  const running = status?.probe.ok === true
  const startWhy = running
    ? '转换服务已经在运行'
    : mmd.auto_start
      ? ''
      : '没打开「默认拉起」'

  return (
    <section className="settings-group">
      <h3>
        转换服务
        {nodeState && (
          <span
            className={`settings-note${nodeState.bad ? ' bad' : ''}`}
            title={nodeState.why === '' ? undefined : nodeState.why}
          >
            {nodeState.text}
          </span>
        )}
      </h3>

      {/* 没有"要不要转"这一档：转成可编辑对象是固有能力，有图就走，服务不在就自动按文本导出。
          这里配的只是"去哪找它"。 */}
      <div className="settings-fields">
        <label className="w-field">
          <span>运行环境</span>
          <div className="w-row">
            <input
              value={mmd.node_path}
              placeholder="留空自动查找"
              onChange={(e) => patchConnection({ node_path: e.target.value })}
            />
            <button
              type="button"
              className="be-btn"
              onClick={() =>
                void (async () => {
                  const exe = await window.documentor.dialog.selectExecutable()
                  if (exe) patchConnection({ node_path: exe })
                })()
              }
            >
              浏览…
            </button>
          </div>
        </label>

        <label className="w-field">
          <span>
            服务程序目录
            {light(dirState)}
          </span>
          <div className="w-row">
            <input
              value={mmd.dir}
              placeholder="如 D:\tools\mmd2vsdx"
              onChange={(e) => patchConnection({ dir: e.target.value })}
            />
            <button
              type="button"
              className="be-btn"
              onClick={() =>
                void (async () => {
                  const dir = await window.documentor.dialog.selectDirectory()
                  if (dir) patchConnection({ dir })
                })()
              }
            >
              浏览…
            </button>
          </div>
        </label>

        <div>
          {/* 地址、端口、「默认拉起」同一行 */}
          <div className="w-row settings-endpoint">
            <label className="w-field settings-host">
              <span>地址</span>
              <input
                value={mmd.host}
                placeholder="127.0.0.1"
                onChange={(e) => patchConnection({ host: e.target.value })}
              />
            </label>
            <label className="w-field settings-port">
              <span>端口</span>
              <input
                value={portText}
                inputMode="numeric"
                placeholder="12138"
                onChange={(e) => onPort(e.target.value)}
              />
            </label>
            <label
              className="settings-check settings-auto-start"
              title="没在运行时替你把它拉起来；启动后不归本软件管，也不会随本软件关闭"
            >
              <input
                type="checkbox"
                checked={mmd.auto_start}
                onChange={(e) => patch({ auto_start: e.target.checked })}
              />
              <span>默认拉起</span>
            </label>
          </div>
        </div>
      </div>

      {/* 服务现状落在「测试连接」左边：它本来就是那一下的结果 */}
      <div className="settings-mmd-actions">
        {line(serviceLine)}
        <div className="w-row">
          <button
            type="button"
            className="be-btn"
            disabled={busy !== null}
            onClick={() => void test()}
          >
            {busy === 'test' ? '正在连接…' : '测试连接'}
          </button>
          <button
            type="button"
            className="be-btn"
            disabled={busy !== null || !mmd.auto_start || running}
            title={startWhy}
            onClick={() => void start()}
          >
            {busy === 'start' ? '正在启动…' : '启动服务'}
          </button>
        </div>
      </div>
    </section>
  )
}

export function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { showToast } = useApp()
  const [cfg, setCfg] = useState<AppConfigDto | null>(null)
  const [saving, setSaving] = useState(false)
  const [report, setReport] = useState<TemplateLoadReport | null>(null)

  const refreshReport = async (): Promise<void> => {
    try {
      setReport(await window.documentor.templates.diagnose())
    } catch {
      setReport(null)
    }
  }

  useEffect(() => {
    void window.documentor.settings.get().then(setCfg)
    void refreshReport()
  }, [])

  const browseDir = async (onPick: (path: string) => void): Promise<void> => {
    const dir = await window.documentor.dialog.selectDirectory()
    if (dir) onPick(dir)
  }

  /** 找出某个目录的加载结果（按路径原样比对；大小写与斜杠差异交给主进程侧） */
  const reportFor = (dir: string): TemplateLoadReport['dirs'][number] | undefined =>
    report?.dirs.find((d) => d.dir === dir)

  const save = async (): Promise<void> => {
    if (!cfg) return
    setSaving(true)
    try {
      await window.documentor.settings.set({
        default_project_dir: cfg.default_project_dir,
        template_dirs: cfg.template_dirs,
        mmd2vsdx: cfg.mmd2vsdx
      })
      // 保存后主进程已重载模板，立刻刷新加载结果
      await refreshReport()
      showToast({ kind: 'info', text: '设置已保存' })
      onClose()
    } catch (err) {
      showToast({ kind: 'error', text: `设置保存失败：${errorText(err)}` })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="wizard-overlay" role="dialog" aria-modal="true" aria-label="设置">
      <div className="wizard settings-dialog">
        <header className="wizard-head">
          <h2>设置</h2>
          <button type="button" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </header>
        {cfg && (
          <div className="settings-body">
            <ThemeSection />
            <section className="settings-group">
              <h3>默认工程目录</h3>
              <div className="w-row">
                <input
                  value={cfg.default_project_dir}
                  placeholder="新建工程向导的起始目录"
                  onChange={(e) =>
                    setCfg({ ...cfg, default_project_dir: e.target.value })
                  }
                />
                <button
                  type="button"
                  className="be-btn"
                  onClick={() => void browseDir((d) => setCfg({ ...cfg, default_project_dir: d }))}
                >
                  浏览…
                </button>
              </div>
            </section>
            <section className="settings-group">
              <h3>模板目录</h3>
              <div className="settings-dirs">
                {cfg.template_dirs.map((dir, i) => {
                  const r = dir.trim() ? reportFor(dir) : undefined
                  let status: string | null = null
                  let bad = false
                  if (r) {
                    if (!r.exists) {
                      status = '目录不存在'
                      bad = true
                    } else if (r.loadFailed) {
                      status = '未加载到模板'
                      bad = true
                    } else {
                      status = `已加载 ${r.structures} 套结构、${r.styles} 套样式`
                    }
                  }
                  return (
                    <div key={`${dir}-${i}`}>
                      <div className="w-row">
                        <input
                          value={dir}
                          placeholder="模板目录（要选到模板仓库的 packages 子目录）"
                          onChange={(e) => {
                            const next = [...cfg.template_dirs]
                            next[i] = e.target.value
                            setCfg({ ...cfg, template_dirs: next })
                          }}
                        />
                        <button
                          type="button"
                          className="be-btn"
                          onClick={() => void browseDir((d) => {
                            const next = [...cfg.template_dirs]
                            next[i] = d
                            setCfg({ ...cfg, template_dirs: next })
                          })}
                        >
                          浏览…
                        </button>
                        <button
                          type="button"
                          className="be-btn danger-text"
                          onClick={() =>
                            setCfg({ ...cfg, template_dirs: cfg.template_dirs.filter((_, j) => j !== i) })
                          }
                        >
                          移除
                        </button>
                      </div>
                      {status && (
                        <p className={`settings-status${bad ? ' bad' : ''}`}>{status}</p>
                      )}
                      {/* 少加载了什么就一条一行地说，最多三条，不堆成一段 */}
                      {r?.reasons.slice(0, 3).map((reason, k) => (
                        <p key={`reason-${k}`} className={`settings-status${bad ? ' bad' : ''}`}>
                          {reason}
                        </p>
                      ))}
                      {r && r.reasons.length > 3 && (
                        <p className="settings-status">还有 {r.reasons.length - 3} 条同类问题已省略</p>
                      )}
                      {r?.warnings.slice(0, 3).map((warning, k) => (
                        <p key={`warning-${k}`} className="settings-status">
                          {warning}
                        </p>
                      ))}
                      {r && r.warnings.length > 3 && (
                        <p className="settings-status">还有 {r.warnings.length - 3} 条提示已省略</p>
                      )}
                    </div>
                  )
                })}
                <button
                  type="button"
                  className="be-btn settings-add-dir"
                  onClick={() => setCfg({ ...cfg, template_dirs: [...cfg.template_dirs, ''] })}
                >
                  ＋ 添加模板目录
                </button>
              </div>
              {report && !report.loadedAny && cfg.template_dirs.some((d) => d.trim()) && (
                <p className="settings-status bad">没有加载到任何模板，新建工程向导会是空的</p>
              )}
            </section>
            <MmdSection cfg={cfg} onChange={setCfg} />
          </div>
        )}
        <footer className="wizard-foot">
          <div className="settings-foot-actions">
            <button type="button" className="be-btn" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button
              type="button"
              className="be-btn be-btn-primary"
              disabled={!cfg || saving}
              onClick={() => void save()}
            >
              保存设置
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
