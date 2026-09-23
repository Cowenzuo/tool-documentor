/**
 * 设置对话框：主题、默认工程目录、模板目录列表（增删/浏览；保存后主进程即时重载模板）、
 * 图转换服务（mmd2vsdx）。
 * 每个模板目录就地显示加载结果——配错一层目录时，这里要说清为什么没加载到。
 * 「模板目录」一节只管配置：增删目录、看每个目录加载到什么。
 * 「转换服务」一节只管配置与连通性：它是个外部件，本软件**不接管它的生命周期**——
 * 只探测、按需点火（启动后立刻撒手），没有「停止服务」。
 * 模板编辑的入口不在这里——它在欢迎页（与新建/打开工程并排），那里不打开工程也能进。
 */
import { useEffect, useState } from 'react'
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
 * 三件事得说清楚：
 *   1. 它是个**外部件**（不在发行包里，版权边界），所以 Node、目录、地址三样都得用户给；
 *   2. 「测试连接」与「启动服务」都会**先把这一节落盘**再动作——主进程读的是 config.json，
 *      不先存就等于在测旧值，那种"改了没反应"最难查；
 *   3. 只有「启动服务」，没有「停止服务」：服务不归我们管，上游也没提供关机接口。
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

  const patch = (part: Partial<AppConfigDto['mmd2vsdx']>): void =>
    onChange({ ...cfg, mmd2vsdx: { ...mmd, ...part } })

  const persist = async (): Promise<void> => {
    await window.documentor.settings.set({ mmd2vsdx: mmd })
  }

  const test = async (): Promise<void> => {
    setBusy('test')
    try {
      await persist()
      setStatus(await window.documentor.mmd.status())
    } catch (err) {
      showToast({ kind: 'error', text: `连接失败：${errorText(err)}` })
    } finally {
      setBusy(null)
    }
  }

  const start = async (): Promise<void> => {
    setBusy('start')
    try {
      await persist()
      const result = await window.documentor.mmd.start()
      const text = result.detail ? `${result.reason}：${result.detail}` : result.reason
      showToast({ kind: result.ok ? 'info' : 'error', text })
      setStatus(await window.documentor.mmd.status())
    } catch (err) {
      showToast({ kind: 'error', text: `启动失败：${errorText(err)}` })
    } finally {
      setBusy(null)
    }
  }

  const firstNodeReason = status?.node_candidates[0]?.reason

  return (
    <section className="settings-group">
      <h3>转换服务</h3>
      <p className="settings-hint">
        流程图导出成可双击编辑的 Visio 对象，靠本机一个常驻服务完成；它不随本软件分发，
        要单独准备（Node、服务程序目录、首次还要装一次浏览器内核）。
      </p>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={mmd.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        <span>导出时把流程图转成可编辑对象</span>
      </label>

      <div className="settings-dirs">
        <div>
          <div className="w-row">
            <input
              value={mmd.node_path}
              placeholder="Node 可执行文件（留空自动查找）"
              onChange={(e) => patch({ node_path: e.target.value })}
            />
          </div>
          {status &&
            (status.node ? (
              <p className="settings-status">
                Node {status.node.version}（{status.node.source}）
                {status.node.electron_as_node ? '，用的是软件自带的' : ''}
              </p>
            ) : (
              <p className="settings-status bad">
                没找到可用的 Node{firstNodeReason ? `：${firstNodeReason}` : '（需要 22.2 以上）'}
              </p>
            ))}
        </div>

        <div>
          <div className="w-row">
            <input
              value={mmd.dir}
              placeholder="服务程序目录（含 bin 那一层）"
              onChange={(e) => patch({ dir: e.target.value })}
            />
            <button
              type="button"
              className="be-btn"
              onClick={() =>
                void (async () => {
                  const dir = await window.documentor.dialog.selectDirectory()
                  if (dir) patch({ dir })
                })()
              }
            >
              浏览…
            </button>
          </div>
          {status && !status.dir_ok && (
            <p className="settings-status bad">
              这个目录里没找到服务程序（应当在 bin 子目录下）
            </p>
          )}
        </div>

        <div className="w-row">
          <input
            value={mmd.endpoint}
            placeholder="服务地址"
            onChange={(e) => patch({ endpoint: e.target.value })}
          />
        </div>
      </div>

      <label className="settings-check">
        <input
          type="checkbox"
          checked={mmd.auto_start}
          onChange={(e) => patch({ auto_start: e.target.checked })}
        />
        <span>没在运行时就启动它（启动后不归本软件管，也不会随本软件关闭）</span>
      </label>

      <div className="w-row settings-mmd-actions">
        <button type="button" className="be-btn" disabled={busy !== null} onClick={() => void test()}>
          {busy === 'test' ? '正在连接…' : '测试连接'}
        </button>
        <button
          type="button"
          className="be-btn"
          disabled={busy !== null || !mmd.auto_start}
          onClick={() => void start()}
        >
          {busy === 'start' ? '正在启动…' : '启动服务'}
        </button>
      </div>
      {status && (
        <p className={`settings-status${status.probe.ok ? '' : ' bad'}`}>
          {status.probe.ok && status.probe.health
            ? `服务可用：版本 ${status.probe.health.serviceVersion}，` +
              `接口版本 ${status.probe.health.contractVersion}，` +
              `渲染器 ${status.probe.health.chromium}`
            : status.probe.reason}
        </p>
      )}
      {status && !status.probe.ok && status.probe.detail && (
        <p className="settings-status">{status.probe.detail}</p>
      )}
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
