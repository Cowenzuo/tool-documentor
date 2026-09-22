/** Welcome.tsx — 欢迎页：品牌区与最近工程面板左右分栏。 */

import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { AppConfigDto } from '../../../shared/project'
import { useApp } from '../state/AppContext'
import { BrandDocGlyph } from '../components/icons'
import { CreateProjectWizard } from './CreateProjectWizard'
import './welcome.css'

const FALLBACK_VERSION = '0.1.1-alpha1'

interface RecentItem {
  path: string
  /** 工程文件夹名（最近打开的主显示） */
  folder: string
}

export default function Welcome(): JSX.Element {
  const { openProjectByPath, busy, openTemplateEditor } = useApp()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [recents, setRecents] = useState<RecentItem[]>([])
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.documentor.settings.get().then((cfg: AppConfigDto) => {
      const items = (cfg.recents ?? []).map((path) => {
        const parts = path.split(/[\\/]/).filter(Boolean)
        return { path, folder: parts[parts.length - 2] ?? path }
      })
      setRecents(items)
    })
    void window.documentor
      .getAppInfo()
      .then((info) => setVersion(info.version))
      .catch(() => undefined)
  }, [])

  const openFile = async (): Promise<void> => {
    const path = await window.documentor.dialog.selectDproj()
    if (path) await openProjectByPath(path)
  }

  return (
    <main className="app-main welcome">
      <div className="welcome-wrap">
        <div className="welcome-split">
          <aside className="welcome-brand">
            <div className="welcome-logo" aria-hidden="true">
              <BrandDocGlyph size={30} />
            </div>
            <div className="welcome-title-row">
              <h1 className="welcome-title">Documentor</h1>
              <span className="welcome-version">v{version || FALLBACK_VERSION}</span>
            </div>
            <p className="welcome-subtitle">模板驱动的结构化文档写作台</p>
            <div className="welcome-actions">
              <button
                type="button"
                className="btn-primary btn-xl"
                disabled={busy}
                onClick={() => setWizardOpen(true)}
              >
                新建工程
              </button>
              <button
                type="button"
                className="btn-secondary btn-xl"
                disabled={busy}
                onClick={() => void openFile()}
              >
                打开工程…
              </button>
              {/* 模板编辑与工程无关（不打开工程、不进撤销栈），所以就在主页面这一排里，
                  不用先新建/打开一个工程再绕进设置 */}
              <button
                type="button"
                className="btn-secondary btn-xl"
                disabled={busy}
                title="编辑本机模板目录"
                onClick={openTemplateEditor}
              >
                模板编辑
              </button>
            </div>
          </aside>

          <section className="welcome-recents welcome-recents-panel">
            <div className="welcome-recents-title">最近打开</div>
            {recents.length > 0 ? (
              <ul>
                {recents.map((item) => (
                  <li key={item.path}>
                    <button
                      type="button"
                      title={item.path}
                      disabled={busy}
                      onClick={() => void openProjectByPath(item.path)}
                    >
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
                        <path d="M2 4.5h4.2L8 6h6v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" />
                      </svg>
                      <span className="recent-text">
                        <span className="recent-main">{item.folder}</span>
                        <span className="recent-sub">{item.path}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="welcome-recents-empty">暂无最近打开的工程</div>
            )}
          </section>
        </div>
      </div>

      <div className="welcome-footer">
        <span className="welcome-copyright">© {new Date().getFullYear()} Documentor</span>
      </div>

      {wizardOpen && <CreateProjectWizard onClose={() => setWizardOpen(false)} />}
    </main>
  )
}
