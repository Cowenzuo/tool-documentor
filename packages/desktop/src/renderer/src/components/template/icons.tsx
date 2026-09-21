/**
 * 模板编辑页自己的小图标：小按钮一律用图标 + 悬停提示（`title`），不再写「上移」「删除」这种字。
 * 页面要能独立成自己的根（PLAN-11 第 3 节），所以图标也自带一份，不借 editor 那边的；
 * 上下移与删除的路径与主编辑器块卡片一致，两处看着是同一套动作。
 * 用法：`<button className="tpl-icon-btn" title="…" aria-label="…"><MoveUpIcon /></button>`
 */
import type { JSX } from 'react'

interface IconProps {
  size?: number
  className?: string
}

export function MoveUpIcon({ size = 13, className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden="true">
      <path d="M8 2.5 13 8h-3v5H6V8H3Z" fill="currentColor" />
    </svg>
  )
}

export function MoveDownIcon({ size = 13, className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden="true">
      <path d="m8 13.5-5-5.5h3V3h4v5h3Z" fill="currentColor" />
    </svg>
  )
}

export function TrashIcon({ size = 13, className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden="true">
      <path
        d="M6.5 2h3l.5.5V4H12v1H4V4h2V2.5Zm-2 3h7l-.6 8.1a1 1 0 0 1-1 .9H6.1a1 1 0 0 1-1-.9Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function PlusIcon({ size = 13, className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden="true">
      <path d="M7.25 3h1.5v4.25H13v1.5H8.75V13h-1.5V8.75H3v-1.5h4.25Z" fill="currentColor" />
    </svg>
  )
}

export function PencilIcon({ size = 13, className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden="true">
      <path
        d="M11.4 2.3a1.7 1.7 0 0 1 2.4 2.4l-.9.9-2.4-2.4Zm-1.7 1.7 2.4 2.4-5.9 5.9-3.1.7.7-3.1Z"
        fill="currentColor"
      />
    </svg>
  )
}

export function RefreshIcon({ size = 13, className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden="true">
      <path
        d="M12.8 8a4.8 4.8 0 1 1-1.6-3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M13.4 1.9v3.6H9.8Z" fill="currentColor" />
    </svg>
  )
}

/** 加子节点：左边一条竖线（当前的层级）＋右下角的加号 */
export function AddChildIcon({ size = 13, className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden="true">
      <path d="M4 2.5v8h3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M11 7.4v6M8 10.4h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** 加同级：一条横线（同一层）＋加号 */
export function AddSiblingIcon({ size = 13, className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden="true">
      <path d="M2.5 8h3.2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path
        d="M11 4.6v6.8M7.6 8h6.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function ExpandAllIcon({ size = 13, className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden="true">
      <path
        d="m4 3.6 4 3.6 4-3.6M4 8.8l4 3.6 4-3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function CollapseAllIcon({ size = 13, className }: IconProps): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={className} aria-hidden="true">
      <path
        d="m4 12.4 4-3.6 4 3.6M4 7.2 8 3.6l4 3.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
