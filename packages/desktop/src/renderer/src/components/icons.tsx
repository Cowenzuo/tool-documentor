/**
 * 线性图标集（stroke 1.5 / 24 viewBox），颜色继承 currentColor。
 * 组件仅渲染 svg 本身，尺寸由调用方 className / style 控制。
 */
import type { JSX } from 'react'

interface IconProps {
  size?: number
  className?: string
}

function base(size: number): { width: number; height: number; viewBox: string } {
  return { width: size, height: size, viewBox: '0 0 24 24' }
}

export function MinimizeIcon({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      <path d="M5.5 12.5h13" />
    </svg>
  )
}

export function MaximizeIcon({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="5.5" y="5.5" width="13" height="13" rx="1.5" />
    </svg>
  )
}

export function RestoreIcon({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
      <rect x="5" y="8.5" width="10.5" height="10.5" rx="1.5" />
      <path d="M8.5 5.5h7a3 3 0 0 1 3 3v7" />
    </svg>
  )
}

export function CloseIcon({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}

export function SettingsIcon({ size = 16, className }: IconProps): JSX.Element {
  return (
    <svg {...base(size)} className={className} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  )
}

/** 品牌文档图标（渐变底上的白描文档，欢迎页/标题栏共用） */
export function BrandDocGlyph({
  size = 20,
  color = '#fff',
  className
}: {
  size?: number
  color?: string
  className?: string
}): React.JSX.Element {
  return (
    <svg
      {...base(size)}
      className={className}
      fill="none"
      stroke={color}
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3.5h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z" />
      <path d="M14 3.5v4h4M8.5 12h7M8.5 15.5h5" />
    </svg>
  )
}