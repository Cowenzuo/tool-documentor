/**
 * Mermaid 渲染（懒加载引擎单例，供编辑器分栏与预览视图共用）。
 */
let enginePromise: Promise<typeof import('mermaid')> | null = null

export function ensureMermaidEngine(): Promise<typeof import('mermaid')> {
  if (!enginePromise) {
    enginePromise = import('mermaid').then((mod) => {
      const mermaid = mod.default
      mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' })
      return mod
    })
  }
  return enginePromise
}

let renderSeq = 0

/** 渲染 Mermaid 源码 → SVG 字符串；失败抛出 */
export async function renderMermaidSvg(code: string): Promise<string> {
  const mod = await ensureMermaidEngine()
  renderSeq += 1
  const id = `dmd-${Date.now().toString(36)}-${renderSeq.toString(36)}`
  const { svg } = await mod.default.render(id, code)
  return svg
}

/** 把渲染出的 svg 栅格化为 PNG 并缓存到工程 mermaid/<hash>.png（失败静默） */
export async function writeMermaidPngCache(svg: string, code: string): Promise<void> {
  try {
    const hash = await sha256Hex(code)
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg load failed'))
      img.src = url
    })
    const scale = 2
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth * scale
    canvas.height = img.naturalHeight * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0)
    URL.revokeObjectURL(url)
    const dataUrl = canvas.toDataURL('image/png')
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    await window.documentor.block.writeBytes({
      relPath: `mermaid/${hash}.png`,
      base64
    })
  } catch {
    /* 缓存写入失败不影响编辑 */
  }
}

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
}
