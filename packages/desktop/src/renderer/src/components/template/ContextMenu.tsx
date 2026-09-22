/**
 * 页内右键菜单：模板列表与节点树共用同一套行为——
 * 开在指针处、贴边时收回窗口内、点别处或按 Esc 收起、开出来焦点落在第一个可用项、
 * 上下方向键在可用项之间走。按不动的项在悬停提示里写明原因（菜单里不另占版面）。
 *
 * 打开的是什么（节点路径 / 模板项）由调用方放进 `payload`：这一层只管菜单本身。
 */
import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode, type RefObject } from 'react'

export interface MenuPoint {
  x: number
  y: number
}

export interface MenuItem {
  label: string
  /** 悬停提示：只在能做的说不了（按不了的原因、有副作用的地方）才给，别复述 label */
  title?: string
  disabled?: boolean
  danger?: boolean
  run: () => void
}

export interface ContextMenuControl<T> {
  /** 当前打开的是哪一个（没开就是 null） */
  payload: T | null
  /** 实际渲染位置（已按窗口边界收回） */
  point: MenuPoint | null
  ref: RefObject<HTMLDivElement | null>
  onKeyDown: (event: KeyboardEvent) => void
  openIn: (payload: T, x: number, y: number) => void
  close: () => void
}

export function useContextMenu<T>(): ContextMenuControl<T> {
  const ref = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<{ payload: T; point: MenuPoint } | null>(null)

  /** 点别处、按 Esc 都收起来 */
  useEffect(() => {
    const close = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) setState(null)
    }
    const key = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setState(null)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key)
    }
  }, [])

  /** 开出来先把越界的部分收回来，再把焦点放到第一个能用的项目上（键盘能接着走） */
  useEffect(() => {
    const el = ref.current
    if (!state || !el) return
    const rect = el.getBoundingClientRect()
    const overflowX = rect.right - window.innerWidth + 8
    const overflowY = rect.bottom - window.innerHeight + 8
    if (overflowX > 0 || overflowY > 0) {
      setState((prev) =>
        prev
          ? {
              ...prev,
              point: {
                x: prev.point.x - Math.max(0, overflowX),
                y: prev.point.y - Math.max(0, overflowY)
              }
            }
          : prev
      )
      return
    }
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
  }, [state])

  const onKeyDown = (event: KeyboardEvent): void => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
    if (items.length === 0) return
    const index = items.findIndex((el) => el === document.activeElement)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      items[(index + 1 + items.length) % items.length]?.focus()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      items[(index - 1 + items.length) % items.length]?.focus()
    }
  }

  return {
    payload: state ? state.payload : null,
    point: state ? state.point : null,
    ref,
    onKeyDown,
    openIn: (payload, x, y) => setState({ payload, point: { x, y } }),
    close: () => setState(null)
  }
}

/** 菜单外壳：定位、语义、菜单头 + 调用方给的菜单项 */
export function ContextMenu<T>({
  control,
  className,
  label,
  head,
  headTitle,
  items
}: {
  control: ContextMenuControl<T>
  /** 菜单自己的类名（尺寸与配色两处一样，见 template.css 的共用规则） */
  className: string
  /** 读屏用的名字 */
  label: string
  head: string
  headTitle?: string
  items: MenuItem[]
}): JSX.Element | null {
  if (!control.point) return null
  return (
    <div
      ref={control.ref}
      className={className}
      style={{ left: control.point.x, top: control.point.y }}
      role="menu"
      aria-label={label}
      onKeyDown={control.onKeyDown}
    >
      <div className={`${className}-head`} title={headTitle}>
        {head}
      </div>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? 'danger' : undefined}
          disabled={item.disabled === true}
          title={item.title}
          onClick={() => {
            item.run()
            control.close()
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
