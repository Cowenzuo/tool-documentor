/** ThemeProvider.tsx — 主题上下文：亮色与暗色 token 切换，选择结果写回应用配置。 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode
} from 'react'

export type ThemePreference = 'system' | 'dark' | 'light'
export type ResolvedTheme = 'dark' | 'light'

const STORAGE_KEY = 'doc-theme'

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'dark' || value === 'light') {
      return value
    }
  } catch {
    /* localStorage 不可用时退回跟随系统 */
  }
  return 'system'
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export interface ThemeContextValue {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference)
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches
  )
  const transitionTimer = useRef<number | undefined>(undefined)

  const resolved: ResolvedTheme =
    preference === 'system' ? (systemDark ? 'dark' : 'light') : preference

  // 跟随系统主题变化
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // 应用 data-theme + 挂临时过渡类
  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = resolved
    root.classList.add('theme-switching')
    window.clearTimeout(transitionTimer.current)
    transitionTimer.current = window.setTimeout(() => {
      root.classList.remove('theme-switching')
    }, 180)
    return () => window.clearTimeout(transitionTimer.current)
  }, [resolved])

  // 持久化偏好
  useEffect(() => {
    try {
      if (preference === 'system') {
        localStorage.removeItem(STORAGE_KEY)
      } else {
        localStorage.setItem(STORAGE_KEY, preference)
      }
    } catch {
      /* 忽略：读不到配置就回退默认主题 */
    }
  }, [preference])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
  }, [])

  const value = useMemo(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) {
    throw new Error('useTheme must be used within ThemeProvider')
  }
  return value
}
