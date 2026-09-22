/** TitleBar.tsx — 无边框窗口标题栏：工程名居中，操作区标 no-drag 保证可点击。 */

import { useEffect, useState } from 'react'
import { useApp } from '../state/AppContext'
import { errorText } from '../utils/errorText'
import { CloseIcon, FolderOpenIcon, MaximizeIcon, MinimizeIcon, RestoreIcon, BrandDocGlyph } from './icons'
import './titlebar.css'

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
  const { session, openExport } = useApp()
  if (!session) return null
  return (
    <button
      type="button"
      className="tb-btn tb-action"
      onClick={openExport}
      title="导出 DOCX"
      aria-label="导出 DOCX"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3.5v11M7.5 10.5 12 15l4.5-4.5" />
        <path d="M4.5 19.5h15" />
      </svg>
      <span>导出</span>
    </button>
  )
}

function RevealFolderButton(): React.JSX.Element | null {
  const { session, showToast } = useApp()
  if (!session) return null
  return (
    <button
      type="button"
      className="tb-btn tb-action"
      onClick={() => {
        // 成功不弹提示：资源管理器已经打开了，再报一次是噪音；失败必须说出来
        void window.documentor.project.revealFolder().catch((err: unknown) => {
          showToast({ kind: 'error', text: `定位失败：${errorText(err)}` })
        })
      }}
      title="在文件管理器里打开工程目录"
      aria-label="定位工程目录"
    >
      <FolderOpenIcon size={15} />
      <span>定位</span>
    </button>
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
      title="保存并退出工程，回到欢迎页"
      aria-label="退出工程"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 4.5h3.5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H15" />
        <path d="M10 8l-4 4 4 4M6 12h9" />
      </svg>
      <span>退出</span>
    </button>
  )
}

function SettingsButton(): React.JSX.Element {
  const { openSettings } = useApp()
  return (
    <button
      type="button"
      className="tb-btn"
      onClick={openSettings}
      title="设置"
      aria-label="设置"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
      </svg>
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

  useEffect(() => {
    document.title = session ? `Documentor - ${session.info.name}` : 'Documentor'
  }, [session])

  return (
    <header className={`titlebar${isMac ? ' titlebar-mac' : ''}`}>
      <div className="tb-left">
        <span className="tb-logo" aria-hidden="true">
          <BrandDocGlyph size={13} />
        </span>
        <span className="tb-appname">Documentor</span>
      </div>

      <div className="tb-center" aria-hidden={!session}>
        {session ? session.info.name : ''}
      </div>

      <div className="tb-right">
        <SaveButton />
        <ExportButton />
        <RevealFolderButton />
        <CloseProjectButton />
        <span className="tb-divider" />
        <SettingsButton />
        {!isMac && <WindowControls />}
      </div>
    </header>
  )
}
