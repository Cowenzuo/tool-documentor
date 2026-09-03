import type { JSX } from 'react'
import TitleBar from './components/TitleBar'
import { ToastHost } from './components/Toast'
import Welcome from './pages/Welcome'
import Editor from './pages/Editor'
import { AppProvider, useApp } from './state/AppContext'
import { ThemeProvider } from './theme/ThemeProvider'

function Shell(): JSX.Element {
  const { session } = useApp()
  return (
    <div className="app-shell">
      <TitleBar />
      {session ? <Editor /> : <Welcome />}
      <ToastHost />
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
