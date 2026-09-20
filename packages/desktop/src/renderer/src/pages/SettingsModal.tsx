/**
 * 设置对话框：主题、默认工程目录、模板目录列表（增删/浏览；保存后主进程即时重载模板）。
 * 每个模板目录就地显示加载结果——配错一层目录时，这里要说清为什么没加载到。
 * 「模板目录」一节末尾还有「模板编辑」入口：打开整页的模板编辑模式（PLAN-11 批次 2）。
 */
import { useEffect, useState } from 'react'
import type { AppConfigDto, TemplateLoadReport } from '../../../shared/project'
import { useApp } from '../state/AppContext'
import { useTheme, type ThemePreference } from '../theme/ThemeProvider'

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

export function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { showToast, openTemplateEditor } = useApp()
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
        template_dirs: cfg.template_dirs
      })
      // 保存后主进程已重载模板，立刻刷新加载结果
      await refreshReport()
      showToast({ kind: 'info', text: '设置已保存' })
      onClose()
    } catch (err) {
      showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
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
                    } else if (!r.hasManifest) {
                      status = '这一层没有模板清单，已跳过'
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
                <div className="w-row">
                  <button
                    type="button"
                    className="be-btn"
                    disabled={saving}
                    title="打开模板编辑页；编辑的是已保存的模板目录"
                    onClick={() => {
                      // 模板编辑是整页，弹层压在上面会把页面挡住；这里一起关掉
                      openTemplateEditor()
                      onClose()
                    }}
                  >
                    模板编辑
                  </button>
                </div>
              </div>
              {report && !report.loadedAny && cfg.template_dirs.some((d) => d.trim()) && (
                <p className="settings-status bad">没有加载到任何模板，新建工程向导会是空的</p>
              )}
            </section>
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
