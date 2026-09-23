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
 * 排法照设置页的既有口径：**一行配置 + 紧跟一条就地状态**（范本是「模板目录」那节，
 * 一行只出一条，最多三条就折叠）。这里三个字段不同质，所以带标签（用向导那套 `.w-field`），
 * 长解释一律进悬停提示，不占版面。
 *
 * 三条边界：
 *   1. 它是**外部件**（不进发行包），运行环境、目录、地址都得用户给，缺哪样就地一句话说清；
 *   2. 「测试连接」「启动服务」拿的是**表单现值、不写盘**——没点「保存设置」就等于没配，
 *      所以「取消」仍然是取消；
 *   3. 只有「启动服务」，没有「停止服务」：服务不归本软件管，上游也没提供关机接口。
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

  const patch = (part: Partial<AppConfigDto['mmd2vsdx']>): void =>
    onChange({ ...cfg, mmd2vsdx: { ...mmd, ...part } })

  const test = async (): Promise<void> => {
    setBusy('test')
    try {
      setStatus(await window.documentor.mmd.status(mmd))
    } catch (err) {
      showToast({ kind: 'error', text: `连接失败：${errorText(err)}` })
    } finally {
      setBusy(null)
    }
  }

  const start = async (): Promise<void> => {
    setBusy('start')
    try {
      const result = await window.documentor.mmd.start(mmd)
      const text = result.detail ? `${result.reason}：${result.detail}` : result.reason
      showToast({ kind: result.ok ? 'info' : 'error', text })
      setStatus(await window.documentor.mmd.status(mmd))
    } catch (err) {
      showToast({ kind: 'error', text: `启动失败：${errorText(err)}` })
    } finally {
      setBusy(null)
    }
  }

  // 一行一条：查到了什么、缺什么，就地一句话。关掉这一节就不显示状态（省得一片红）
  const shown = mmd.enabled ? status : null
  const nodeLine = ((): { text: string; bad: boolean } | null => {
    if (!shown) return null
    if (shown.node) return { text: `运行环境 ${shown.node.version}`, bad: false }
    if (mmd.node_path.trim() !== '') {
      const why = shown.node_candidates[0]?.reason
      return { text: why ? `这个运行环境用不了：${why}` : '这个运行环境用不了', bad: true }
    }
    return { text: '没找到可用的运行环境（需要 22.2 以上）', bad: true }
  })()
  const dirLine = ((): { text: string; bad: boolean } | null => {
    if (!shown || mmd.dir.trim() === '') return null
    return shown.dir_ok
      ? { text: '已找到服务程序', bad: false }
      : { text: '这个目录里没有服务程序', bad: true }
  })()
  const serviceLine = ((): { text: string; bad: boolean } | null => {
    if (!shown) return null
    if (shown.probe.ok && shown.probe.health) {
      return { text: `服务可用 · ${shown.probe.health.serviceVersion}`, bad: false }
    }
    return { text: shown.probe.reason, bad: true }
  })()

  const line = (value: { text: string; bad: boolean } | null): React.JSX.Element | null =>
    value === null ? null : (
      <p className={`settings-status${value.bad ? ' bad' : ''}`}>{value.text}</p>
    )

  return (
    <section className="settings-group">
      <h3>转换服务</h3>

      {/* 两个开关并排在最前：它们决定下面三个字段算不算数 */}
      <div className="settings-toggles">
        <label className="settings-check" title="不勾就不做转换，流程图按文本导出">
          <input
            type="checkbox"
            checked={mmd.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span>导出时把流程图转成可编辑对象</span>
        </label>
        <label className="settings-check" title="启动后不归本软件管，也不会随本软件关闭">
          <input
            type="checkbox"
            checked={mmd.auto_start}
            onChange={(e) => patch({ auto_start: e.target.checked })}
          />
          <span>没在运行时自动启动</span>
        </label>
      </div>

      <div className="settings-fields">
        <div>
          <label className="w-field">
            <span>运行环境</span>
            <input
              value={mmd.node_path}
              placeholder="留空自动查找"
              onChange={(e) => patch({ node_path: e.target.value })}
            />
          </label>
          {line(nodeLine)}
        </div>

        <div>
          <label className="w-field">
            <span>服务程序目录</span>
            <div className="w-row">
              <input
                value={mmd.dir}
                placeholder="服务程序所在的那一层目录"
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
          </label>
          {line(dirLine)}
        </div>

        <div>
          <label className="w-field">
            <span>服务地址</span>
            <input
              value={mmd.endpoint}
              placeholder="http://127.0.0.1:12138"
              onChange={(e) => patch({ endpoint: e.target.value })}
            />
          </label>
          {line(serviceLine)}
        </div>
      </div>

      <div className="w-row settings-mmd-actions">
        <button
          type="button"
          className="be-btn"
          disabled={busy !== null || !mmd.enabled}
          title={mmd.enabled ? '' : '图转换已关闭'}
          onClick={() => void test()}
        >
          {busy === 'test' ? '正在连接…' : '测试连接'}
        </button>
        <button
          type="button"
          className="be-btn"
          disabled={busy !== null || !mmd.enabled || !mmd.auto_start}
          title={mmd.auto_start ? '' : '没打开「没在运行时自动启动」'}
          onClick={() => void start()}
        >
          {busy === 'start' ? '正在启动…' : '启动服务'}
        </button>
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
