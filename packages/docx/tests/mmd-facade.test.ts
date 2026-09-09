/**
 * mmd-facade.test.ts — 上游门面解析（PLAN-05 P0-1 我方侧准备）
 *
 * 覆盖三种兼容形态与失败诊断，确保上游门面无论以
 * 「新包根导出 / 旧 application 对象 / default 包裹」哪种形式出现，
 * 我方适配都无需再改代码（真实链路由 DOC_REAL_MMD=1 的契约测试兜底）。
 */
import { describe, expect, it, vi } from 'vitest'
import { resolveMmdFacade } from '../src/figure-export'

describe('resolveMmdFacade', () => {
  it('新形态：包根导出 convertText / shutdown', async () => {
    const convertText = vi.fn(async () => ({ ok: true, vsdxBase64: 'x' }))
    const shutdown = vi.fn(async () => undefined)
    const facade = resolveMmdFacade({ convertText, shutdown })

    await expect(facade.convertText('graph TD\n A-->B')).resolves.toMatchObject({ ok: true })
    await facade.shutdown?.()
    expect(convertText).toHaveBeenCalledOnce()
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('旧形态：application 对象承载同名方法', async () => {
    const convertText = vi.fn(async () => ({ ok: true, vsdxBase64: 'y' }))
    const facade = resolveMmdFacade({ application: { convertText, shutdown: async () => undefined } })

    await expect(facade.convertText('graph TD\n A-->B')).resolves.toMatchObject({ vsdxBase64: 'y' })
    expect(convertText).toHaveBeenCalledOnce()
  })

  it('CJS/ESM 互操作：default 包裹', async () => {
    const convertText = vi.fn(async () => ({ ok: true, vsdxBase64: 'z' }))
    const facade = resolveMmdFacade({ default: { convertText } })
    await expect(facade.convertText('x')).resolves.toMatchObject({ vsdxBase64: 'z' })
    expect(facade.shutdown).toBeUndefined()
  })

  it('保留 this：方法内部依赖实例状态时仍可调用', async () => {
    const instance = {
      prefix: 'ok:',
      convertText(this: { prefix: string }, text: string) {
        return Promise.resolve({ ok: true, vsdxBase64: this.prefix + text })
      }
    }
    const facade = resolveMmdFacade({ application: instance })
    await expect(facade.convertText('abc')).resolves.toMatchObject({ vsdxBase64: 'ok:abc' })
  })

  it('无可用门面：抛出含期望契约与文档指针的错误', () => {
    expect(() => resolveMmdFacade({ renderContract: () => {}, kImplementedKinds: new Set() })).toThrow(
      /未提供可用门面[\s\S]*UPSTREAM-mmd2vsdx\.md/
    )
  })

  it('非对象输入：同样给出可读错误', () => {
    expect(() => resolveMmdFacade(null)).toThrow(/未提供可用门面/)
    expect(() => resolveMmdFacade('mmd2vsdx')).toThrow(/typeof string/)
  })
})
