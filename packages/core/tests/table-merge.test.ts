/** table-merge.test.ts — 表格纵向合并判定规则的单测。 */

import { describe, expect, it } from 'vitest'
import {
  computeVerticalMerges,
  countVerticalMerges,
  completeRowSpans,
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

  it('不连续不合并：中间夹不同值各自成组（空串则并入上方）', () => {
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
    // 第 2 列：X,X,X 连续相同；随后 C 行的空串并入上面那一组 →
    // 组一直延续到下一个非空值（D 行的 X）才收束，所以是跨 4 行的一格
    expect(m[0]![1]).toEqual({ rowSpan: 4, covered: false })
    expect(m[1]![1]!.covered).toBe(true)
    expect(m[2]![1]!.covered).toBe(true)
    expect(m[3]![1]!.covered).toBe(true)
    // 末尾 X,X 再合并
    expect(m[4]![1]).toEqual({ rowSpan: 2, covered: false })
    expect(countVerticalMerges(m)).toBe(2)
  })

  it('空串并入上方：列首空串跳过，值后的空串跟着它一起合并', () => {
    const data = [
      ['', '  上游1.5m '],
      ['', '上游1.5m'],
      ['  ', '']
    ]
    const m = computeVerticalMerges(data)
    // 列首两行是空串，上面没有可并入的对象 → 跳过，不合并
    expect(m.every((r) => r[0]!.rowSpan === 1)).toBe(true)
    // 第 2 列：两行同值合并，紧随其后的空串并入该组 → 跨 3 行
    expect(m[0]![1]).toEqual({ rowSpan: 3, covered: false })
    expect(m[1]![1]!.covered).toBe(true)
    expect(m[2]![1]!.covered).toBe(true)
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

  it('用户口径：写入时就是留空——首行有值、下面留空，按同列向上合并', () => {
    // 试验工况表：工况模型只在每组的首行填写，其余留空（导出后就是这个形态）
    const data = [
      ['1', '上游1.5米-下游0.5米', '1.5-0.5-30%'],
      ['2', '', '1.5-0.5-40%'],
      ['3', '', '1.5-0.5-50%'],
      ['4', '上游1.5米-下游1米', '1.5-1.0-30%'],
      ['5', '', '1.5-1.0-40%'],
      ['6', '', '1.5-1.0-50%'],
      ['7', '', '1.5-1.0-60%'],
      ['8', '上游1.5米-下游1.3米', '1.5-1.3- 80%'],
      ['9', '上游1.5米-下游1.5米', '1.5-1.5-100%']
    ]
    const m = computeVerticalMerges(data)
    // 第 2 列：3 行、4 行各并一组；第 8、9 行都是"单行有值 + 后面没有留空" → 不合并
    const spans = []
    for (let r = 0; r < m.length; r++) if (m[r]![1]!.rowSpan > 1) spans.push([r, m[r]![1]!.rowSpan])
    expect(spans).toEqual([
      [0, 3],
      [3, 4]
    ])
    // 留空的行被标成续格，值仍留在原处（判定不改数据）
    expect(m[1]![1]!.covered).toBe(true)
    expect(m[2]![1]!.covered).toBe(true)
    expect(m[5]![1]!.covered).toBe(true)
    expect(m[6]![1]!.covered).toBe(true)
    expect(m[7]![1]!.rowSpan).toBe(1)
    expect(m[8]![1]!.rowSpan).toBe(1)
    expect(data[1]![1]).toBe('')
    expect(countVerticalMerges(m)).toBe(2)
  })

  it('单行有值 + 紧随一行留空 → 跨两行也合并', () => {
    const m = computeVerticalMerges([['A'], [''], ['B'], ['']])
    expect(m[0]![0]).toEqual({ rowSpan: 2, covered: false })
    expect(m[1]![0]!.covered).toBe(true)
    expect(m[2]![0]).toEqual({ rowSpan: 2, covered: false })
    expect(m[3]![0]!.covered).toBe(true)
  })

  it('整列留空时不产生合并（开头空白不并成一格）', () => {
    const m = computeVerticalMerges([[''], [''], ['']])
    expect(countVerticalMerges(m)).toBe(0)
  })
})

describe('resolveTableMerges（显式跨度与兼容判定取并集）', () => {
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

  it('显式跨度与 mergeVertical 各管一段：跨度逐格优先，兼容判定补空', () => {
    const data = [
      ['A', 'x'],
      ['A', 'y'],
      ['A', 'z']
    ]
    // 显式跨度只指定第 1 列的前两行；第 0 列仍由兼容判定合成 3 行。
    // 旧口径是"有跨度就整体接管"，第 0 列的合开会静默消失，这里钉住并集语义。
    const m = resolveTableMerges({ data, rowSpans: { '1': [[0, 2]] }, mergeVertical: true })
    expect(m[0]![0]!.rowSpan).toBe(3)
    expect(m[1]![0]!.covered).toBe(true)
    expect(m[0]![1]).toEqual({ rowSpan: 2, covered: false })
    expect(m[1]![1]!.covered).toBe(true)
    expect(m[2]![1]!.rowSpan).toBe(1)
  })

  it('显式跨度认领的格子不再被兼容判定重复认领', () => {
    const data = [
      ['A', 'x'],
      ['A', 'x'],
      ['A', 'x']
    ]
    // 第 1 列显式覆盖第 1–2 行，兼容判定只能去补第 0 行那段
    const m = resolveTableMerges({ data, rowSpans: { '1': [[1, 2]] }, mergeVertical: true })
    expect(m[1]![1]).toEqual({ rowSpan: 2, covered: false })
    expect(m[2]![1]!.covered).toBe(true)
    expect(m[0]![1]!.rowSpan).toBe(1)
    expect(m[0]![0]!.rowSpan).toBe(3)
  })

  it('completeRowSpans：把缺失的组补成跨度，已覆盖的不重复补', () => {
    const data = [
      ['甲', 'x'],
      ['甲', 'y'],
      ['乙', 'y'],
      ['乙', 'y']
    ]
    // 只声明了第 0 列第 2–3 行；推导会把第 0 列 0–1 行、第 1 列 2–3 行补上
    const { spans, added } = completeRowSpans(data, { '0': [[2, 2]] })
    expect(added).toBe(2)
    expect(spans!['0']).toEqual([[2, 2], [0, 2]])
    expect(spans!['1']).toEqual([[1, 3]])
    // 补完再判定：三处合并都在
    expect(countVerticalMerges(resolveTableMerges({ data, rowSpans: spans }))).toBe(3)
  })

  it('completeRowSpans：本来就齐全时不新增', () => {
    const data = [
      ['甲', 'x'],
      ['甲', 'y']
    ]
    const { added } = completeRowSpans(data, { '0': [[0, 2]] })
    expect(added).toBe(0)
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

  it('列数按表头长度、cols 与数据行长度的最大值取', () => {
    const data = [['A']]
    expect(resolveTableMerges({ data })[0]!.length).toBe(1)
    expect(resolveTableMerges({ data: [['A', 'B', 'C']] })[0]!.length).toBe(3)
    expect(resolveTableMerges({ data, headers: ['H1', 'H2', 'H3', 'H4'] })[0]!.length).toBe(4)
    expect(resolveTableMerges({ data, cols: 5 })[0]!.length).toBe(5)
    // 三者同时给出时取最大，且 cols 声明的列上能落跨度
    const m = resolveTableMerges({
      data: [['甲'], ['甲']],
      headers: ['甲'],
      cols: 2,
      rowSpans: { '1': [[0, 2]] }
    })
    expect(m[0]!.length).toBe(2)
    expect(m[0]![1]).toEqual({ rowSpan: 2, covered: false })
    // 没有数据行时仍是 0 行：不给合并，也不凭空造出表头行
    expect(resolveTableMerges({ data: [], headers: ['A', 'B'], cols: 2 })).toEqual([])
  })

  it('表头 3 列、数据行 2 列时，第 3 列上的跨度必须成立', () => {
    // 缺陷现场：判定只取 max(每行长度)，第 3 列被 c >= cols 当成越界丢掉，
    // 预览与导出都少一处合并。导出侧 writer 的列数是"表头、每行、cols"三者最大值。
    const data = [
      ['1', 'DEMO-001'],
      ['2', 'DEMO-002']
    ]
    const m = resolveTableMerges({
      data,
      headers: ['序号', '标识', '标题'],
      rowSpans: { '2': [[0, 2]] }
    })
    expect(m[0]!.length).toBe(3)
    expect(m[0]![2]).toEqual({ rowSpan: 2, covered: false })
    expect(m[1]![2]!.covered).toBe(true)
    expect(countVerticalMerges(m)).toBe(1)
    // 不传表头时退回 data 宽度：第 3 列在网格外，跨度丢掉，与旧行为一致
    const noHeaders = resolveTableMerges({ data, rowSpans: { '2': [[0, 2]] } })
    expect(noHeaders[0]!.length).toBe(2)
    expect(countVerticalMerges(noHeaders)).toBe(0)
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
