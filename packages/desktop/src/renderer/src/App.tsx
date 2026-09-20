/** App.tsx — 渲染层根组件，按启动状态在欢迎页、创建向导、编辑器与模板编辑页之间切换。 */

import type { JSX } from 'react'
import TitleBar from './components/TitleBar'
import { ToastHost } from './components/Toast'
import Welcome from './pages/Welcome'
import Editor from './pages/Editor'
import { SettingsModal } from './pages/SettingsModal'
import { ExportDialog } from './pages/ExportDialog'
import TemplateEditorPage from './pages/TemplateEditorPage'
import { AppProvider, useApp } from './state/AppContext'
import { ThemeProvider } from './theme/ThemeProvider'

function Shell(): JSX.Element {
  const {
    session,
    settingsOpen,
    closeSettings,
    exportOpen,
    closeExport,
    templateEditorOpen
  } = useApp()
  return (
    <div className="app-shell">
      <TitleBar />
      {/* 模板编辑是整页：它挡在最前面时不渲染编辑器，也不退出已打开的工程 */}
      {templateEditorOpen ? (
        <TemplateEditorPage />
      ) : session ? (
        <Editor />
      ) : (
        <Welcome />
      )}
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
