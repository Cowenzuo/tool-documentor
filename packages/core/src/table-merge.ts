/**
 * table-merge.ts — 表格纵向合并判定（纯函数，编辑区/预览/导出三处共用同一规则）。
 *
 * 规则（与用户口径一致）：
 * - 只在**数据行**内判定，表头行不参与；
 * - 同一列中**连续**若干行，单元格内容 trim 后非空且**完全相同** → 合并为一格；
 * - 空串不合并（避免把大片空白合成一格）；
 * - 不连续（中间夹了别的值或空串）即使内容相同也各自成组。
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

export function computeVerticalMerges(data: readonly (readonly string[])[]): TableMergeCell[][] {
  const rows = data.length
  const cols = rows === 0 ? 0 : Math.max(...data.map((r) => r.length))
  const out: TableMergeCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ ...NONE }))
  )
  if (rows === 0 || cols === 0) return out

  for (let c = 0; c < cols; c++) {
    let start = -1
    let key = ''
    // 收尾 [start, end) 这一段连续相同值
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

/** 合并块数量（UI 上给「已检测到 N 处合并」用） */
export function countVerticalMerges(merges: readonly (readonly TableMergeCell[])[]): number {
  let n = 0
  for (const row of merges) for (const cell of row) if (cell.rowSpan > 1) n++
  return n
}
