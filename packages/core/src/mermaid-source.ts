/**
 * mermaid-source.ts — Mermaid 源码规整（core 唯一定义，编辑器渲染与导出转换共用）。
 *
 * 为什么需要：用户从文档或聊天里复制图定义时，常常把 **markdown 代码围栏**一起带进来，
 * 于是源码第一行变成语言标签本身：
 *
 * ```text
 * mermaid          ← 这一行会让解析器报
 * flowchart TD     ←   "No diagram type detected matching given configuration"
 *   A --> B
 * ```
 *
 * 渲染端与导出端都吃这份源码，所以规整必须放在两边共用的地方，不能各写一份。
 */

/** 裸语言标签：整行只有它，没有别的图定义内容 */
const BARE_TAG = /^(?:mermaid|mmd)\s*$/iu

/**
 * 规整 Mermaid 源码：
 * - 去掉一行 ``` 或 ```mermaid 围栏（首尾都要去）；
 * - 去掉首行的裸语言标签 `mermaid` / `mmd`；
 * - 规整行尾空白与首尾空行。
 *
 * 只做这些——不猜图类型、不补语法、不纠正图定义本身。
 */
export function normalizeMermaidSource(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''

  let lines = raw.replace(/\r\n?/gu, '\n').split('\n')

  // 1) 围栏：```mermaid / ``` / ~~~ 之类
  const isFence = (s: string): boolean => /^\s*(?:`{3,}|~{3,})/u.test(s)
  if (lines.length > 0 && isFence(lines[0]!)) {
    lines = lines.slice(1)
    if (lines.length > 0 && isFence(lines[lines.length - 1]!)) lines = lines.slice(0, -1)
  }

  // 2) 首行裸语言标签（含去掉围栏后露出来的那一行）
  while (lines.length > 0 && lines[0]!.trim().length === 0) lines = lines.slice(1)
  if (lines.length > 0 && BARE_TAG.test(lines[0]!.trim())) lines = lines.slice(1)

  // 3) 单行包裹：整段就是 `mermaid flowchart TD ...`（围栏去掉后可能并成一行）
  if (lines.length === 1) {
    const single = /^\s*(?:mermaid|mmd)\s+(?=\S)/iu.exec(lines[0]!)
    if (single) lines = [lines[0]!.slice(single[0].length)]
  }

  // 4) 收尾：去尾部空行与每行行尾空白
  const out = lines.map((l) => l.replace(/\s+$/u, ''))
  while (out.length > 0 && out[out.length - 1]!.length === 0) out.pop()
  return out.join('\n')
}

/** 判断规整前后是否有变化（用于需要提示"已自动清理"的场合） */
export function isMermaidSourceDirty(raw: string): boolean {
  return normalizeMermaidSource(raw) !== (typeof raw === 'string' ? raw.replace(/\r\n?/gu, '\n') : '')
}
