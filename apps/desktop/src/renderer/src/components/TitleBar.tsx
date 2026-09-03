import { useEffect, useState } from 'react'
import { useApp } from '../state/AppContext'
import { useTheme, type ThemePreference } from '../theme/ThemeProvider'
import { SettingsModal } from '../pages/SettingsModal'
import { ExportDialog } from '../pages/ExportDialog'
import { CloseIcon, MaximizeIcon, MinimizeIcon, MonitorIcon, MoonIcon, RestoreIcon, SunIcon } from './icons'
import './titlebar.css'

const CYCLE_ORDER: ThemePreference[] = ['system', 'dark', 'light']

const THEME_LABEL: Record<ThemePreference, string> = {
  system: '跟随系统',
  dark: '深色',
  light: '浅色'
}

const THEME_ICON = {
  system: MonitorIcon,
  dark: MoonIcon,
  light: SunIcon
} as const

function ThemeSwitchButton(): React.JSX.Element {
  const { preference, setPreference } = useTheme()
  const Icon = THEME_ICON[preference]

  const cycle = (): void => {
    const index = CYCLE_ORDER.indexOf(preference)
    setPreference(CYCLE_ORDER[(index + 1) % CYCLE_ORDER.length]!)
  }

  return (
    <button
      type="button"
      className="tb-btn"
      onClick={cycle}
      title={`主题：${THEME_LABEL[preference]}（点击切换）`}
      aria-label={`主题：${THEME_LABEL[preference]}，点击切换`}
    >
      <Icon size={15} />
    </button>
  )
}

function SaveButton(): React.JSX.Element | null {
  const { session, saveProject, busy } = useApp()
  if (!session) return null
  return (
    <button
      type="button"
      className="tb-btn tb-action"
      onClick={() => void saveProject()}
      disabled={busy}
      title="保存 (Ctrl+S)"
      aria-label="保存工程"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M5 3.5h11l2.5 2.5V20.5H5Z" />
        <path d="M8.5 3.5v5h7v-5M8.5 20.5v-6h7v6" />
      </svg>
      <span>保存</span>
    </button>
  )
}

function ExportButton(): React.JSX.Element | null {
  const { session } = useApp()
  const [open, setOpen] = useState(false)
  if (!session) return null
  return (
    <>
      <button
        type="button"
        className="tb-btn tb-action"
        onClick={() => setOpen(true)}
        title="导出 DOCX"
        aria-label="导出 DOCX"
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5" />
          <path d="M4.5 19.5h15" />
        </svg>
        <span>导出</span>
      </button>
      {open && <ExportDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function CloseProjectButton(): React.JSX.Element | null {
  const { session, closeProject } = useApp()
  if (!session) return null
  return (
    <button
      type="button"
      className="tb-btn tb-action"
      onClick={() => void closeProject()}
      title="保存并关闭工程"
      aria-label="关闭工程"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6.5h16M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7M6.3 6.5 7 19.2a1.5 1.5 0 0 0 1.5 1.3h7a1.5 1.5 0 0 0 1.5-1.3l.7-12.7" />
      </svg>
      <span>关闭工程</span>
    </button>
  )
}

function WindowControls(): React.JSX.Element {
  const api = window.documentor
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    let disposed = false
    void api.window.isMaximized().then((value) => {
      if (!disposed) setMaximized(value)
    })
    const unsubscribe = api.window.onMaximizedChange(setMaximized)
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [api])

  return (
    <div className="tb-window-controls">
      <button
        type="button"
        className="tb-win-btn"
        onClick={() => api.window.minimize()}
        aria-label="最小化"
        title="最小化"
      >
        <MinimizeIcon size={13} />
      </button>
      <button
        type="button"
        className="tb-win-btn"
        onClick={() => api.window.toggleMaximize()}
        aria-label={maximized ? '还原' : '最大化'}
        title={maximized ? '还原' : '最大化'}
      >
        {maximized ? <RestoreIcon size={13} /> : <MaximizeIcon size={13} />}
      </button>
      <button
        type="button"
        className="tb-win-btn tb-win-close"
        onClick={() => api.window.close()}
        aria-label="关闭"
        title="关闭"
      >
        <CloseIcon size={13} />
      </button>
    </div>
  )
}

export default function TitleBar(): React.JSX.Element {
  const isMac = window.documentor.platform === 'darwin'
  const { session } = useApp()
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    document.title = session ? `Documentor - ${session.info.name}` : 'Documentor'
  }, [session])

  return (
    <header className={`titlebar${isMac ? ' titlebar-mac' : ''}`}>
      <div className="tb-brand">
        <span className="tb-logo" aria-hidden="true">
          <span className="tb-logo-mark">D</span>
        </span>
        <span className="tb-appname">Documentor</span>
        {session && <span className="tb-project">{session.info.name}</span>}
        <span className="tb-divider" />
        <SaveButton />
        <ExportButton />
        <CloseProjectButton />
      </div>
      <div className="tb-actions">
        <button
          type="button"
          className="tb-btn"
          onClick={() => setSettingsOpen(true)}
          title="设置"
          aria-label="设置"
        >
          <SettingsGlyph />
        </button>
        <ThemeSwitchButton />
        {!isMac && <WindowControls />}
      </div>
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </header>
  )
}

function SettingsGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  )
}
