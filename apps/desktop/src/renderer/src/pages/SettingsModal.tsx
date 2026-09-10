/**
 * 设置对话框：默认工程目录 + 模板目录列表（增删/浏览；保存后主进程即时重载模板）。
 */
import { useEffect, useState } from 'react'
import type { AppConfigDto } from '../../../shared/project'
import { useApp } from '../state/AppContext'

export function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { showToast } = useApp()
  const [cfg, setCfg] = useState<AppConfigDto | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void window.documentor.settings.get().then(setCfg)
  }, [])

  const browseDir = async (onPick: (path: string) => void): Promise<void> => {
    const dir = await window.documentor.dialog.selectDirectory()
    if (dir) onPick(dir)
  }

  const save = async (): Promise<void> => {
    if (!cfg) return
    setSaving(true)
    try {
      await window.documentor.settings.set({
        default_project_dir: cfg.default_project_dir,
        template_dirs: cfg.template_dirs
      })
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
              <p className="settings-hint">
                选择包含模板的目录；多个目录存在同名模板时，靠前的目录优先。
              </p>
              <div className="settings-dirs">
                {cfg.template_dirs.map((dir, i) => (
                  <div key={`${dir}-${i}`} className="w-row">
                    <input
                      value={dir}
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
                ))}
                <button
                  type="button"
                  className="be-btn"
                  onClick={() => setCfg({ ...cfg, template_dirs: [...cfg.template_dirs, ''] })}
                >
                  ＋ 添加模板目录
                </button>
              </div>
            </section>
          </div>
        )}
        <footer className="wizard-foot">
          <span />
          <button
            type="button"
            className="be-btn be-btn-primary"
            disabled={!cfg || saving}
            onClick={() => void save()}
          >
            保存设置
          </button>
        </footer>
      </div>
    </div>
  )
}
