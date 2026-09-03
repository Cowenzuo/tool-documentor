import { useApp } from '../state/AppContext'

/** 全局 toast（右下角瞬态提示） */
export function ToastHost(): React.JSX.Element | null {
  const { toast } = useApp()
  if (!toast) return null
  return (
    <div className={`toast toast-${toast.kind}`} role="status">
      {toast.text}
    </div>
  )
}
