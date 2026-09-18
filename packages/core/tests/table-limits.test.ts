/** table-limits.test.ts — 表格形状校验的单测。 */

import { describe, expect, it } from 'vitest'
import { checkTableShape } from '../src/table-limits'

describe('checkTableShape（形状校验）', () => {
  it('合法表格没有问题', () => {
    expect(
      checkTableShape({
        cols: 2,
        rows: 2,
        headers: ['A', 'B'],
        data: [
          ['1', '2'],
          ['3', '4']
        ]
      })
    ).toEqual([])
  })

  it('表头长度与 cols 不一致要报出来', () => {
    const issues = checkTableShape({ cols: 3, headers: ['A', 'B'], data: [] })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.where).toBe('headers')
  })

  it('无表头（长度 0）不算错', () => {
    expect(checkTableShape({ cols: 2, headers: [], data: [['1', '2']] })).toEqual([])
  })

  it('某行列数与 cols 不一致要报出来，并带行号', () => {
    const issues = checkTableShape({
      cols: 2,
      headers: [],
      data: [
        ['1', '2'],
        ['3']
      ]
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.where).toBe('data[1]')
    expect(issues[0]!.reason).toContain('第 2 行')
  })

  it('rows 小于数据行数只提示不报错（历史口径）', () => {
    const issues = checkTableShape({ cols: 1, rows: 2, data: [['a'], ['b'], ['c'], ['d']] })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.where).toBe('rows')
    expect(issues[0]!.reason).toContain('建议改为 4')
  })

  it('cols 非法直接返回一条，不再继续检查', () => {
    const issues = checkTableShape({ cols: 0, headers: ['A'], data: [['x']] })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.where).toBe('cols')
  })
})
