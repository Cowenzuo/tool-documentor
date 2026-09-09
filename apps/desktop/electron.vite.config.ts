import { createHash } from 'node:crypto'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * 生产环境 CSP（仅构建时注入；开发环境保持宽松——HMR 需要内联脚本与 ws 连接）。
 *
 * 设计要点：
 * - 渲染层经 `loadFile` 以 file:// 加载，故各来源显式包含 `file:`（Chromium 对
 *   不透明来源不匹配 `'self'`）；
 * - head 内的防闪烁内联脚本用 **sha256 哈希**放行（而非 'unsafe-inline'）：
 *   构建时读取 index.html 内联脚本内容计算哈希，保证 script-src 仍然严格；
 * - Mermaid/KaTeX 运行期注入 `<style>`，故 style-src 需 `'unsafe-inline'`；
 * - 图片含用户导入的 data URL 与 blob。
 */
const CSP_BASE = [
  "default-src 'self' file:",
  "style-src 'self' 'unsafe-inline' file:",
  "img-src 'self' data: blob: file:",
  "font-src 'self' data: file:",
  "connect-src 'self' file:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'"
]

/** 收集 head 内联脚本的 sha256（跳过带 src 与 type="module" 的脚本） */
function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = []
  const re = /<script(?![^>]*\bsrc=)(?![^>]*type=["']module["'])[^>]*>([\s\S]*?)<\/script>/gi
  for (const m of html.matchAll(re)) {
    const content = m[1] ?? ''
    if (content.trim().length === 0) continue
    hashes.push(`'sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}'`)
  }
  return hashes
}

function cspPlugin(): Plugin {
  return {
    name: 'documentor-csp',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const scriptSrc = ["script-src 'self' file:", ...inlineScriptHashes(html)].join(' ')
        const csp = [...CSP_BASE, scriptSrc].join('; ')
        return html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`
        )
      }
    }
  }
}

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), cspPlugin()]
  }
})
