/**
 * 图片/Mermaid 全屏预览（滚轮缩放 + 拖拽平移 + Esc/点击关闭）。
 */
import { useEffect, useRef, useState } from 'react'
import type { LightboxRequest } from './editor/BlockEditors'

export function Lightbox({
  request,
  onClose
}: {
  request: LightboxRequest
  onClose: () => void
}): React.JSX.Element {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ startX: number; startY: number; ox: number; oy: number } | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onWheel = (e: React.WheelEvent): void => {
    const delta = e.deltaY > 0 ? 0.9 : 1.1
    setScale((s) => Math.min(8, Math.max(0.1, s * delta)))
  }

  return (
    <div
      className="lightbox"
      onClick={onClose}
      onWheel={onWheel}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) return
        dragRef.current = { startX: e.clientX, startY: e.clientY, ox: offset.x, oy: offset.y }
      }}
      onMouseMove={(e) => {
        const drag = dragRef.current
        if (!drag) return
        setOffset({ x: drag.ox + e.clientX - drag.startX, y: drag.oy + e.clientY - drag.startY })
      }}
      onMouseUp={() => {
        dragRef.current = null
      }}
      onMouseLeave={() => {
        dragRef.current = null
      }}
    >
      <div className="lightbox-toolbar">
        <span>{request.title ?? ''}</span>
        <button type="button" onClick={onClose} aria-label="关闭">
          <svg viewBox="0 0 16 16" width="14" height="14">
            <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <img
        src={request.src}
        alt={request.title ?? '预览'}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          cursor: 'grab'
        }}
        draggable={false}
        onClick={(e) => e.stopPropagation()}
      />
      <div className="lightbox-hint">滚轮缩放 · 拖拽平移 · Esc 关闭</div>
    </div>
  )
}
