/**
 * table-merge.ts — 表格纵向合并的判定（纯函数，编辑区/预览/导出三处共用）。
 *
 * 两种来源，**显式跨度优先**：
 *
 * 1. **显式跨度** `rowSpans`（推荐，新数据）：`{ 列号: [[起始行, 跨几行], ...] }`。
 *    跨行是数据本身的一部分，不靠内容推断——因此值可以照常保留、取消合并即可恢复。
 * 2. **兼容判定**（老数据/老模板）：`mergeVertical: true` 时，同列**连续**若干行内容
 *    trim 后非空且完全相同 → 合并；空串不合并；不连续各自成组。
 *
 * 第 2 条是为既有工程保留的。它有个固有缺陷：扁平二维数组表达不了跨行，
 * 只能靠内容推断；因此"首行有值、其余留空"这种**合并后的形态**它认不出来，
 * 值一被清空就再也合不上（丢信息）。新数据一律用 rowSpans。
 *
 * 输出与 data 同形状：起点格 rowSpan>1，被覆盖格 covered=true（导出写空续格、预览不渲染）。
 */

export interface TableMergeCell {
  /** 纵向跨度：>1 表示合并块起点 */
  rowSpan: number
  /** 是否被上方合并块覆盖（自身不渲染内容） */
  covered: boolean
}

/** 某列某行的合并态（默认不合并） */
const NONE: TableMergeCell = { rowSpan: 1, covered: false }

/** 表格块里与合并相关的字段（避免 core 反向依赖 blocks 类型） */
export interface TableSpanSource {
  /** 正文行（不含表头） */
  data: readonly (readonly string[])[]
  /** 显式跨度：{ 列号: [[起始行, 跨几行], ...] } */
  rowSpans?: Record<string, Array<[number, number]>>
  /** 兼容开关 */
  mergeVertical?: boolean
}

/** 兼容判定：同列连续、trim 后非空且完全相同 → 合并（老口径，逐字保留） */
function legacyMerges(data: readonly (readonly string[])[]): TableMergeCell[][] {
  const rows = data.length
  const cols = rows === 0 ? 0 : Math.max(...data.map((r) => r.length))
  const out: TableMergeCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ ...NONE }))
  )
  if (rows === 0 || cols === 0) return out

  for (let c = 0; c < cols; c++) {
    let start = -1
    let key = ''
    const close = (end: number): void => {
      if (start < 0) return
      const span = end - start
      if (span > 1) {
        out[start]![c] = { rowSpan: span, covered: false }
        for (let k = start + 1; k < end; k++) out[k]![c] = { rowSpan: 1, covered: true }
      }
      start = -1
    }
    for (let r = 0; r < rows; r++) {
      const cur = (data[r]?.[c] ?? '').trim()
      if (cur.length === 0) {
        close(r)
        continue
      }
      if (start < 0) {
        start = r
        key = cur
        continue
      }
      if (cur !== key) {
        close(r)
        start = r
        key = cur
      }
    }
    close(rows)
  }
  return out
}

/** 把显式跨度摊平成与 data 同形状的合并态 */
function explicitMerges(
  data: readonly (readonly string[])[],
  rowSpans: Record<string, Array<[number, number]>>
): TableMergeCell[][] {
  const rows = data.length
  const cols = rows === 0 ? 0 : Math.max(...data.map((r) => r.length))
  const out: TableMergeCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ ...NONE }))
  )
  if (rows === 0 || cols === 0) return out

  for (const [colKey, spans] of Object.entries(rowSpans)) {
    const c = Number.parseInt(colKey, 10)
    if (!Number.isInteger(c) || c < 0 || c >= cols) continue
    for (const [start, span] of spans) {
      if (!Number.isFinite(start) || !Number.isFinite(span) || span < 2) continue
      const end = Math.min(rows, start + span)
      if (start < 0 || start >= rows || end - start < 2) continue
      // 已有显式跨度重叠时以先到的为准，避免同一格被两个跨度重复认领
      if (out[start]![c]!.rowSpan > 1 || out[start]![c]!.covered) continue
      let conflict = false
      for (let k = start + 1; k < end; k++) {
        if (out[k]![c]!.rowSpan > 1 || out[k]![c]!.covered) conflict = true
      }
      if (conflict) continue
      out[start]![c] = { rowSpan: end - start, covered: false }
      for (let k = start + 1; k < end; k++) out[k]![c] = { rowSpan: 1, covered: true }
    }
  }
  return out
}

/**
 * 计算一张表的纵向合并态。显式跨度优先；没有显式跨度时才退回兼容判定。
 * 编辑区、预览、导出都调这一个函数，保证三处结果一致。
 */
export function resolveTableMerges(src: TableSpanSource): TableMergeCell[][] {
  const { data, rowSpans, mergeVertical } = src
  if (rowSpans && Object.keys(rowSpans).length > 0) return explicitMerges(data, rowSpans)
  if (mergeVertical === true) return legacyMerges(data)
  const rows = data.length
  const cols = rows === 0 ? 0 : Math.max(...data.map((r) => r.length))
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ ...NONE })))
}

/**
 * 兼容入口：只给 data（按老口径判定）。
 * 保留给既有调用方与单测；新代码请用 resolveTableMerges 并把 rowSpans 一并传入。
 */
export function computeVerticalMerges(
  data: readonly (readonly string[])[]
): TableMergeCell[][] {
  return legacyMerges(data)
}

/** 合并块数量（UI 上给「已检测到 N 处合并」用） */
export function countVerticalMerges(merges: readonly (readonly TableMergeCell[])[]): number {
  let n = 0
  for (const row of merges) for (const cell of row) if (cell.rowSpan > 1) n++
  return n
}

/**
 * 从"同列连续相同值"反推显式跨度——**只为老数据自动回填**用（一次性迁移）。
 * 合并只搬运跨度，不改值：返回值直接写进 rowSpans 即可，data 原样保留。
 */
export function inferRowSpansFromData(
  data: readonly (readonly string[])[]
): Record<string, Array<[number, number]>> | undefined {
  const merges = legacyMerges(data)
  const out: Record<string, Array<[number, number]>> = {}
  for (let c = 0; c < (merges[0]?.length ?? 0); c++) {
    const spans: Array<[number, number]> = []
    for (let r = 0; r < merges.length; r++) {
      const m = merges[r]![c]!
      if (m.rowSpan > 1) spans.push([r, m.rowSpan])
    }
    if (spans.length > 0) out[String(c)] = spans
  }
  return Object.keys(out).length > 0 ? out : undefined
}
