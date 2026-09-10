/** table-merge.test.ts — 表格纵向合并判定规则的单测。 */

import { describe, expect, it } from 'vitest'
import { computeVerticalMerges, countVerticalMerges } from '../src/table-merge'

describe('computeVerticalMerges（表格纵向合并判定）', () => {
  it('同列连续相同值合并为一格，起点 rowSpan=跨度、其余 covered', () => {
    const data = [
      ['1', '上游1.5m-下游0.5m', '开度30%'],
      ['2', '上游1.5m-下游0.5m', '开度40%'],
      ['3', '上游1.5m-下游0.5m', '开度50%'],
      ['4', '上游1.5m-下游1m', '开度30%'],
      ['5', '上游1.5m-下游1m', '开度40%']
    ]
    const m = computeVerticalMerges(data)
    expect(m.map((r) => r.map((c) => c.rowSpan))).toEqual([
      [1, 3, 1],
      [1, 1, 1],
      [1, 1, 1],
      [1, 2, 1],
      [1, 1, 1]
    ])
    expect(m[1]![1]!.covered).toBe(true)
    expect(m[3]![1]!.covered).toBe(false)
    expect(countVerticalMerges(m)).toBe(2)
  })

  it('不连续不合并：中间夹不同值或空串各自成组', () => {
    const data = [
      ['A', 'X'],
      ['B', 'X'],
      ['A', 'X'],
      ['C', ''],
      ['D', 'X'],
      ['E', 'X']
    ]
    const m = computeVerticalMerges(data)
    // 第 1 列：A,B,A,C,D,E 均不连续相同 → 无合并
    expect(m.every((r) => r[0]!.rowSpan === 1)).toBe(true)
    // 第 2 列：X,X,X 合并；空串断开；末尾 X,X 再合并
    expect(m[0]![1]).toEqual({ rowSpan: 3, covered: false })
    expect(m[1]![1]!.covered).toBe(true)
    expect(m[2]![1]!.covered).toBe(true)
    expect(m[3]![1]!.covered).toBe(false)
    expect(m[4]![1]).toEqual({ rowSpan: 2, covered: false })
    expect(countVerticalMerges(m)).toBe(2)
  })

  it('空串永不合并；trim 后比较（首尾空白忽略）', () => {
    const data = [
      ['', '  上游1.5m '],
      ['', '上游1.5m'],
      ['  ', '']
    ]
    const m = computeVerticalMerges(data)
    expect(m.every((r) => r[0]!.rowSpan === 1)).toBe(true)
    expect(m[0]![1]).toEqual({ rowSpan: 2, covered: false })
    expect(m[2]![1]!.rowSpan).toBe(1)
    expect(countVerticalMerges(m)).toBe(1)
  })

  it('参差行/空表不抛错（缺列按空串处理）', () => {
    expect(computeVerticalMerges([])).toEqual([])
    const ragged = computeVerticalMerges([['A'], ['A', 'B'], ['B']])
    expect(ragged.map((r) => r.length)).toEqual([2, 2, 2])
    expect(ragged[0]![0]).toEqual({ rowSpan: 2, covered: false })
    expect(ragged[1]![0]!.covered).toBe(true)
    expect(ragged[0]![1]!.rowSpan).toBe(1)
  })

  it('三行以上连续相同也只算一处合并', () => {
    const m = computeVerticalMerges([['1.5-0.5'], ['1.5-0.5'], ['1.5-0.5'], ['1.5-0.5']])
    expect(m[0]![0]).toEqual({ rowSpan: 4, covered: false })
    expect(countVerticalMerges(m)).toBe(1)
  })
})
