import type { JSX } from 'react'
import TitleBar from './components/TitleBar'
import { ToastHost } from './components/Toast'
import Welcome from './pages/Welcome'
import Editor from './pages/Editor'
import { SettingsModal } from './pages/SettingsModal'
import { ExportDialog } from './pages/ExportDialog'
import { AppProvider, useApp } from './state/AppContext'
import { ThemeProvider } from './theme/ThemeProvider'

function Shell(): JSX.Element {
  const { session, settingsOpen, closeSettings, exportOpen, closeExport } = useApp()
  return (
    <div className="app-shell">
      <TitleBar />
      {session ? <Editor /> : <Welcome />}
      <ToastHost />
      {/* 弹层渲染在壳层（脱离标题栏 drag 区域），保证可交互 */}
      {settingsOpen && <SettingsModal onClose={closeSettings} />}
      {exportOpen && session && <ExportDialog onClose={closeExport} />}
    </div>
  )
}

export default function App(): JSX.Element {
  return (
    <ThemeProvider>
      <AppProvider>
        <Shell />
      </AppProvider>
    </ThemeProvider>
  )
}
