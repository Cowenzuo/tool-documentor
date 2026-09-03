import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AppConfigDto } from '../../../shared/project'
import { useApp } from '../state/AppContext'
import { CreateProjectWizard } from './CreateProjectWizard'
import { SettingsModal } from './SettingsModal'
import './welcome.css'

export default function Welcome(): JSX.Element {
  const { openProjectByPath, busy } = useApp()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [recents, setRecents] = useState<string[]>([])

  useEffect(() => {
    void window.documentor.settings.get().then((cfg: AppConfigDto) => {
      setRecents(cfg.recents ?? [])
    })
  }, [])

  const openFile = async (): Promise<void> => {
    const path = await window.documentor.dialog.selectDproj()
    if (path) await openProjectByPath(path)
  }

  const recentNames = recents.map((p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p)

  return (
    <main className="app-main welcome">
      <div className="welcome-card">
        <div className="welcome-hero">
          <div className="welcome-logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 3.5h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z" />
              <path d="M14 3.5v4h4M8.5 12h7M8.5 15.5h5" />
            </svg>
          </div>
          <h1 className="welcome-title">Documentor</h1>
          <p className="welcome-subtitle">模板驱动的结构化文档编辑器 · 输出标准 DOCX</p>
        </div>

        <div className="welcome-actions">
          <button
            type="button"
            className="btn-primary btn-xl"
            disabled={busy}
            onClick={() => setWizardOpen(true)}
          >
            新建工程
          </button>
          <button type="button" className="btn-secondary btn-xl" disabled={busy} onClick={() => void openFile()}>
            打开工程…
          </button>
        </div>

        {recents.length > 0 && (
          <div className="welcome-recents">
            <span className="welcome-recents-title">最近打开</span>
            <ul>
              {recents.map((path, i) => (
                <li key={path}>
                  <button
                    type="button"
                    title={path}
                    disabled={busy}
                    onClick={() => void openProjectByPath(path)}
                  >
                    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.3">
                      <path d="M2 4.5h4.2L8 6h6v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
                    </svg>
                    {recentNames[i]}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="welcome-meta">
          <span className="welcome-version">Documentor · 界面骨架与编辑功能</span>
        </div>
      </div>

      <button
        type="button"
        className="welcome-settings"
        title="设置"
        aria-label="设置"
        onClick={() => setSettingsOpen(true)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
        </svg>
      </button>

      {wizardOpen && <CreateProjectWizard onClose={() => setWizardOpen(false)} />}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </main>
  )
}
