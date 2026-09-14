/** table-merge.test.ts — 表格纵向合并判定规则的单测。 */

import { describe, expect, it } from 'vitest'
import {
  computeVerticalMerges,
  countVerticalMerges,
  inferRowSpansFromData,
  resolveTableMerges
} from '../src/table-merge'

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

describe('resolveTableMerges（显式跨度优先）', () => {
  it('有 rowSpans 时按跨度合并，且不要求内容相同（值保留）', () => {
    // 首行有值、下面留空——扁平数组表达不了跨行，靠 rowSpans 明确指定
    const data = [
      ['1', '上游1.5米-下游0.5米', '1.5-0.5-30%'],
      ['2', '', '1.5-0.5-40%'],
      ['3', '', '1.5-0.5-50%'],
      ['4', '上游1.5米-下游1米', '1.5-1.0-30%']
    ]
    const m = resolveTableMerges({ data, rowSpans: { '1': [[0, 3]] } })
    expect(m[0]![1]).toEqual({ rowSpan: 3, covered: false })
    expect(m[1]![1]!.covered).toBe(true)
    expect(m[2]![1]!.covered).toBe(true)
    expect(m[3]![1]!.rowSpan).toBe(1)
    expect(countVerticalMerges(m)).toBe(1)
  })

  it('显式跨度优先于 mergeVertical：两者都在时按 span 走', () => {
    const data = [
      ['A', 'x'],
      ['A', 'y'],
      ['A', 'z']
    ]
    // 兼容判定会把第 0 列合成 3 行；显式跨度只指定第 1 列
    const m = resolveTableMerges({ data, rowSpans: { '1': [[0, 2]] }, mergeVertical: true })
    expect(m[0]![0]!.rowSpan).toBe(1)
    expect(m[1]![0]!.rowSpan).toBe(1)
    expect(m[0]![1]).toEqual({ rowSpan: 2, covered: false })
    expect(m[1]![1]!.covered).toBe(true)
    expect(m[2]![1]!.rowSpan).toBe(1)
  })

  it('没有 rowSpans 时退回兼容判定（老工程行为不变）', () => {
    const data = [
      ['1', 'A'],
      ['2', 'A']
    ]
    const withFlag = resolveTableMerges({ data, mergeVertical: true })
    expect(withFlag[0]![1]!.rowSpan).toBe(2)
    const without = resolveTableMerges({ data })
    expect(without[0]![1]!.rowSpan).toBe(1)
  })

  it('越界/重叠跨度被夹住，不产出非法合并', () => {
    const data = [['a'], ['b'], ['c']]
    // 起点越界、跨度不足、超出表尾：都应按可用范围处理
    const m = resolveTableMerges({
      data,
      rowSpans: { '0': [[2, 9] as [number, number], [9, 3] as [number, number], [0, 1] as [number, number]] }
    })
    expect(m[2]![0]!.rowSpan).toBe(1) // [2,9] 只有 1 行可用 → 不合并
    expect(m[0]![0]!.rowSpan).toBe(1) // 跨度 1 → 不合并
    expect(countVerticalMerges(m)).toBe(0)
  })

  it('重叠跨度只认先到的那个', () => {
    const data = [['a'], ['b'], ['c']]
    const m = resolveTableMerges({
      data,
      rowSpans: { '0': [[0, 3] as [number, number], [1, 2] as [number, number]] }
    })
    expect(m[0]![0]!.rowSpan).toBe(3)
    expect(m[1]![0]!.covered).toBe(true)
    expect(m[2]![0]!.covered).toBe(true)
    expect(countVerticalMerges(m)).toBe(1)
  })
})

describe('inferRowSpansFromData（老数据回填用）', () => {
  it('把"连续相同值"反推成显式跨度，值不动', () => {
    const data = [
      ['1', 'A'],
      ['2', 'A'],
      ['3', 'B']
    ]
    const spans = inferRowSpansFromData(data)
    expect(spans).toEqual({ '1': [[0, 2]] })
    // 反推的结果喂回 resolveTableMerges 应与兼容判定一致
    expect(resolveTableMerges({ data, rowSpans: spans })).toEqual(computeVerticalMerges(data))
  })

  it('没有可合并内容时返回 undefined', () => {
    expect(inferRowSpansFromData([['a'], ['b']])).toBeUndefined()
    expect(inferRowSpansFromData([])).toBeUndefined()
  })
})
