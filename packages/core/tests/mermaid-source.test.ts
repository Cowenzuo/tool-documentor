/** mermaid-source.test.ts — Mermaid 源码规整的单测。 */

import { describe, expect, it } from 'vitest'
import { isMermaidSourceDirty, normalizeMermaidSource } from '../src/mermaid-source'

/** 用户贴上来的实际内容：语言标签 + 图定义 */
const PASTED = `mermaid
flowchart TD
M12[集成验证模块组]
M12-->A[请求路由]
M12-->B[导演台功能]
M12-->C[模型管理功能]
M12-->D[数据管理功能]
M12-->E[系统检测和追踪]
M12-->F[用户权限控制管理]`

describe('normalizeMermaidSource', () => {
  it('去掉首行裸语言标签（就是渲染失败的那一例）', () => {
    const out = normalizeMermaidSource(PASTED)
    expect(out.startsWith('flowchart TD')).toBe(true)
    expect(out).not.toMatch(/^mermaid/u)
    // 图定义本身一行不少
    expect(out.split('\n')).toHaveLength(8)
    expect(out).toContain('M12-->F[用户权限控制管理]')
  })

  it('去掉 markdown 围栏（含带语言名的围栏）', () => {
    expect(normalizeMermaidSource('```mermaid\nflowchart TD\n  A --> B\n```')).toBe(
      'flowchart TD\n  A --> B'
    )
    expect(normalizeMermaidSource('```\ngraph TD\n  A --> B\n```')).toBe('graph TD\n  A --> B')
    expect(normalizeMermaidSource('~~~mermaid\ngraph TD\n~~~')).toBe('graph TD')
  })

  it('围栏只有开没有闭也能规整', () => {
    expect(normalizeMermaidSource('```mermaid\nflowchart LR\n  A --> B')).toBe(
      'flowchart LR\n  A --> B'
    )
  })

  it('单行包裹也能规整', () => {
    expect(normalizeMermaidSource('mermaid flowchart TD A-->B')).toBe('flowchart TD A-->B')
  })

  it('本来干净的不动它', () => {
    const clean = 'graph TD\n  A[开始] --> B[结束]'
    expect(normalizeMermaidSource(clean)).toBe(clean)
    expect(isMermaidSourceDirty(clean)).toBe(false)
  })

  it('只清包裹，不猜图类型、不补语法', () => {
    // 没有图类型声明：规整后依然没有，交给解析器报错，不替用户决定
    const noType = 'mermaid\n  A --> B'
    expect(normalizeMermaidSource(noType)).toBe('  A --> B')
  })

  it('CRLF、首尾空行、行尾空白一并规整', () => {
    expect(normalizeMermaidSource('\r\n\r\nflowchart TD  \r\n  A --> B \r\n\r\n')).toBe(
      'flowchart TD\n  A --> B'
    )
  })

  it('空串与纯空白返回空串', () => {
    expect(normalizeMermaidSource('')).toBe('')
    expect(normalizeMermaidSource('   \n\n  ')).toBe('')
  })

  it('isMermaidSourceDirty 只在确有变化时为真', () => {
    expect(isMermaidSourceDirty(PASTED)).toBe(true)
    expect(isMermaidSourceDirty('```mermaid\ngraph TD\n```')).toBe(true)
    expect(isMermaidSourceDirty('graph TD\n  A --> B')).toBe(false)
  })

  it('图定义里正常出现的 mermaid 字样不被误删', () => {
    // 只删"整行只有语言标签"与"行首标签 + 内容"的包裹形态，
    // 中间或行内的 mermaid 字样属于图内容
    const withWord = 'flowchart TD\n  A[mermaid 引擎] --> B[导出]'
    expect(normalizeMermaidSource(withWord)).toBe(withWord)
  })
})
