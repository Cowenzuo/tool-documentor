/**
 * 代码高亮（Prism，语言子集按需注册）+ 文本转义兜底。
 */
import Prism from 'prismjs'
import 'prismjs/components/prism-clike'
import 'prismjs/components/prism-c'
import 'prismjs/components/prism-cpp'
import 'prismjs/components/prism-python'
import 'prismjs/components/prism-javascript'
import 'prismjs/components/prism-java'
import 'prismjs/components/prism-csharp'
import 'prismjs/components/prism-sql'
import 'prismjs/components/prism-bash'

const LANG_MAP: Record<string, string> = {
  cpp: 'cpp',
  python: 'python',
  javascript: 'javascript',
  java: 'java',
  csharp: 'csharp',
  sql: 'sql',
  bash: 'bash'
}

export function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 返回高亮 HTML；无对应语法时纯文本转义 */
export function highlightCode(code: string, language: string): string {
  const grammarName = LANG_MAP[language]
  if (!grammarName) return escapeHtmlText(code)
  const grammar = Prism.languages[grammarName]
  if (!grammar) return escapeHtmlText(code)
  try {
    return Prism.highlight(code, grammar, grammarName)
  } catch {
    return escapeHtmlText(code)
  }
}
