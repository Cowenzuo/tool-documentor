/**
 * table-merge.ts — 表格纵向合并的判定（纯函数，编辑区/预览/导出三处共用）。
 *
 * 两种来源，**显式跨度优先**：
 *
 * 1. **显式跨度** `rowSpans`（推荐，新数据）：`{ 列号: [[起始行, 跨几行], ...] }`。
 *    跨行是数据本身的一部分，不靠内容推断——因此值可以照常保留、取消合并即可恢复。
 * 2. **兼容判定**（老数据/老模板）：`mergeVertical: true` 时，同列按下述两种形态合并：
 *    - **连续相同**：连续若干行 trim 后非空且完全相同 → 合成一格（老写法，保留）；
 *    - **空串向上合并**：非空值后面跟的**连续空串**并入上面那一格——这正是"留空 = 续格"
 *      的写法，也是合并后的形态。组延续到下一个非空值为止。
 *    列首的空串没有可并入的对象，跳过（不把开头整片空白并成一格）。
 *
 * 第 2 条是为既有工程保留的。它靠内容推断，因此**只认得上述两种形态**；
 * 想把跨行与内容彻底解耦（值随你怎么填、合并都成立），用第 1 条的 rowSpans。
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
function legacyMerges(
  data: readonly (readonly string[])[],
  claimed?: readonly (readonly boolean[])[]
): TableMergeCell[][] {
  const rows = data.length
  const cols = rows === 0 ? 0 : Math.max(...data.map((r) => r.length))
  const out: TableMergeCell[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => ({ ...NONE }))
  )
  if (rows === 0 || cols === 0) return out

  for (let c = 0; c < cols; c++) {
    let start = -1
    let key = ''
    let sawBlank = false
    const close = (end: number): void => {
      if (start < 0) return
      const span = end - start
      if (span > 1) {
        out[start]![c] = { rowSpan: span, covered: false }
        for (let k = start + 1; k < end; k++) out[k]![c] = { rowSpan: 1, covered: true }
      }
      start = -1
      key = ''
      sawBlank = false
    }
    for (let r = 0; r < rows; r++) {
      // 已被显式跨度认领的格子不参与推断，并就地截断当前组——
      // 兼容判定只补显式跨度没覆盖到的部分，不与它抢格子
      if (claimed?.[r]?.[c] === true) {
        close(r)
        continue
      }
      const cur = (data[r]?.[c] ?? '').trim()
      if (cur.length === 0) {
        // 空串并入上方那一格（"留空 = 续格"的写法），组延续到下一个非空值
        if (start < 0) continue // 列首的空串没有可并入的对象，跳过
        sawBlank = true
        continue
      }
      if (start < 0) {
        start = r
        key = cur
        continue
      }
      // 遇到新的非空值：同值且中间没夹空串 → 仍在同一组（兼容"重复写值"的老写法）；
      // 否则收束当前组——中间的连续空串已随这一组一起合并。
      if (cur === key && !sawBlank) continue
      close(r)
      start = r
      key = cur
    }
    close(rows)
  }
  return out
}

/**
 * 把显式跨度摊平成与 data 同形状的合并态，并把占用的格子记进 claimed。
 * 已有显式跨度重叠时以先到的为准，避免同一格被两个跨度重复认领。
 */
function applyExplicit(
  out: TableMergeCell[][],
  claimed: boolean[][],
  data: readonly (readonly string[])[],
  rowSpans: Record<string, Array<[number, number]>>
): void {
  const rows = data.length
  const cols = rows === 0 ? 0 : Math.max(...data.map((r) => r.length))
  if (rows === 0 || cols === 0) return

  for (const [colKey, spans] of Object.entries(rowSpans)) {
    const c = Number.parseInt(colKey, 10)
    if (!Number.isInteger(c) || c < 0 || c >= cols) continue
    for (const [start, span] of spans) {
      if (!Number.isFinite(start) || !Number.isFinite(span) || span < 2) continue
      const end = Math.min(rows, start + span)
      if (start < 0 || start >= rows || end - start < 2) continue
      let conflict = claimed[start]![c] === true
      if (!conflict) {
        for (let k = start + 1; k < end; k++) {
          if (claimed[k]![c] === true) conflict = true
        }
      }
      if (conflict) continue
      out[start]![c] = { rowSpan: end - start, covered: false }
      claimed[start]![c] = true
      for (let k = start + 1; k < end; k++) {
        out[k]![c] = { rowSpan: 1, covered: true }
        claimed[k]![c] = true
      }
    }
  }
}

/** 空白网格 */
function emptyGrid(rows: number, cols: number): TableMergeCell[][] {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ ...NONE })))
}

/**
 * 计算一张表的纵向合并态。编辑区、预览、导出都调这一个函数。
 *
 * 两种来源**各管一段，不是二选一**：
 * 1. 显式跨度 `rowSpans` 逐格优先，认领过的格子不被兼容判定再碰；
 * 2. `mergeVertical` 开时，兼容判定（连续相同 + 空串向上）**补上没被认领的部分**。
 *
 * 旧规则是"有 rowSpans 就整体接管"，于是一张表只要带了不完整的跨度，
 * 其余该合的地方就静默不合了；现在加跨度只会增加合并，不会让别处的合并消失。
 */
export function resolveTableMerges(src: TableSpanSource): TableMergeCell[][] {
  const { data, rowSpans, mergeVertical } = src
  const rows = data.length
  const cols = rows === 0 ? 0 : Math.max(...data.map((r) => r.length))
  const out = emptyGrid(rows, cols)
  if (rows === 0 || cols === 0) return out

  const claimed: boolean[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => false)
  )
  if (rowSpans && Object.keys(rowSpans).length > 0) {
    applyExplicit(out, claimed, data, rowSpans)
  }
  if (mergeVertical === true) {
    const legacy = legacyMerges(data, claimed)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (claimed[r]![c] === true) continue
        out[r]![c] = legacy[r]![c] ?? { ...NONE }
      }
    }
  }
  return out
}

/**
 * 补齐合并跨度：把"同列相邻的相同非空值""非空值后跟的空串"这些成组形态，
 * 补成显式跨度（与已有跨度取并集），只写跨度、不碰 data。
 * 返回补齐后的跨度与新增处数；没有可补的返回 added = 0。
 *
 * 用途：接手旧版或外部带进来的残缺跨度时，由用户在界面上确认后调用，不静默改写数据。
 */
export function completeRowSpans(
  data: readonly (readonly string[])[],
  existing?: Record<string, Array<[number, number]>>
): { spans: Record<string, Array<[number, number]>> | undefined; added: number } {
  const inferred = inferRowSpansFromData(data) ?? {}
  const merged: Record<string, Array<[number, number]>> = {}
  for (const [col, list] of Object.entries(existing ?? {})) {
    merged[col] = [...list]
  }
  let added = 0
  for (const [col, list] of Object.entries(inferred)) {
    const current = merged[col] ?? []
    for (const span of list) {
      const covered = current.some(([s, n]) => span[0] < s + n && s < span[0] + span[1])
      if (covered) continue
      current.push(span)
      added += 1
    }
    if (current.length > 0) merged[col] = current
  }
  const spans = Object.keys(merged).length > 0 ? merged : undefined
  return { spans, added }
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
