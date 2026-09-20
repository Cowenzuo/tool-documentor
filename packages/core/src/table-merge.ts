/**
 * table-merge.ts — 表格纵向合并的判定（纯函数，编辑区/预览/导出三处共用）。
 *
 * 两种来源，**取并集**：
 *
 * 1. **显式跨度** `rowSpans`（推荐，新数据）：`{ 列号: [[起始行, 跨几行], ...] }`。
 *    跨行是数据本身的一部分，不靠内容推断——因此值可以照常保留、取消合并即可恢复。
 *    逐格优先，认领过的格子不再被兼容判定碰。
 * 2. **兼容判定**（老数据/老模板）：`mergeVertical: true` 时，同列按下述两种形态合并：
 *    - **连续相同**：连续若干行 trim 后非空且完全相同 → 合成一格（老写法，保留）；
 *    - **空串向上合并**：非空值后面跟的**连续空串**并入上面那一格——这正是"留空 = 续格"
 *      的写法，也是合并后的形态。组延续到下一个非空值为止。
 *    列首的空串没有可并入的对象，跳过（不把开头整片空白并成一格）。
 *    它只补显式跨度没认领的部分，于是加跨度只会增加合并，不会让别处的合并消失。
 *
 * 第 2 条是为既有工程保留的。它靠内容推断，因此**只认得上述两种形态**；
 * 想把跨行与内容彻底解耦（值随你怎么填、合并都成立），用第 1 条的 rowSpans。
 *
 * 列数取表头长度、提示性 cols、各数据行长度的最大值：这是导出侧 writer 的口径，
 * 判定必须跟着走，否则表头比数据行宽的表会在多出来的那几列上丢跨度。
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
  /** 表头。不在 data 里，但和正文行同属这张表的列 */
  headers?: readonly string[]
  /** 提示性列数元数据。模板与实例 JSON 可能给 0 或干脆不给 */
  cols?: number
  /** 显式跨度：{ 列号: [[起始行, 跨几行], ...] } */
  rowSpans?: Record<string, Array<[number, number]>>
  /** 兼容开关 */
  mergeVertical?: boolean
}

/**
 * 判定用的列数：表头长度、提示性 cols、各数据行长度的最大值，至少 1 列。
 * 只取 data 宽度会漏掉两类列：表头比数据行宽时表头占的列，
 * 以及 cols 声明的列。这两类列上的显式跨度会被 `c >= cols` 当成越界丢掉。
 * data 为空时给 0，调用方据此返回空网格，保持"没有数据行就没有合并"。
 */
function tableCols(src: {
  data: readonly (readonly string[])[]
  headers?: readonly string[]
  cols?: number
}): number {
  if (src.data.length === 0) return 0
  return Math.max(1, src.headers?.length ?? 0, src.cols ?? 0, ...src.data.map((r) => r.length))
}

/**
 * 兼容判定：同列连续、trim 后非空且完全相同 → 合并（老口径，逐字保留）。
 * cols 不传时按 data 自身宽度算，这时与旧行为一致。
 */
function legacyMerges(
  data: readonly (readonly string[])[],
  claimed?: readonly (readonly boolean[])[],
  colsArg?: number
): TableMergeCell[][] {
  const rows = data.length
  const cols = colsArg ?? (rows === 0 ? 0 : Math.max(...data.map((r) => r.length)))
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
  rowSpans: Record<string, Array<[number, number]>>,
  rows: number,
  cols: number
): void {
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
 *
 * 列数取表头长度、提示性 cols 与各数据行长度的最大值：写入侧（导出）就是这个口径，
 * 判定这边跟着走，否则"表头 3 列、数据行 2 列"的表会在第 3 列上丢跨度。
 */
export function resolveTableMerges(src: TableSpanSource): TableMergeCell[][] {
  const { data, rowSpans, mergeVertical } = src
  const rows = data.length
  const cols = tableCols(src)
  const out = emptyGrid(rows, cols)
  if (rows === 0 || cols === 0) return out

  const claimed: boolean[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => false)
  )
  if (rowSpans && Object.keys(rowSpans).length > 0) {
    applyExplicit(out, claimed, rowSpans, rows, cols)
  }
  if (mergeVertical === true) {
    const legacy = legacyMerges(data, claimed, cols)
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
 * 缩表后按新尺寸重算显式跨度（纯函数，只动跨度、不动 data）。
 *
 * 表缩小以后，原先记下的跨度可能有一部分落在表外：起点在表外、尾部超出末行、
 * 整列被删掉。原样留着的话，导出与预览会按越界的跨度去写合并——落到空处或与列错位。
 * 所以每次改尺寸都按新尺寸裁一遍：
 * - 列号 >= cols 的整列丢弃（该列已经不存在）；
 * - 起点不在 [0, rows) 的跨度丢弃；
 * - 尾部超出 rows 的截短到表尾；截短后不足 2 行（含原本就不足 2 行）的丢弃——
 *   单行没有可合并的对象；
 * - 列号非法（非整数/负数）与起点、跨度非有限数的丢弃。
 *
 * 判定口径与 resolveTableMerges 里 applyExplicit 的接受规则**逐条一致**：
 * 这里留下的跨度，正是判定与导出还会认的那些；不会裁掉仍能生效的跨度，
 * 也不会留下判定本来就会忽略的残渣。
 *
 * `changed` 表示结果与输入是否真的有差别：没差别就别写回，省一次无谓的入库与重渲染。
 * 没有任何跨度剩下时 `spans` 返回 undefined（与 completeRowSpans 同口径），
 * 调用方据此把 rowSpans 字段清掉，而不是留个空对象。
 */
export function clampRowSpans(
  spans: Record<string, Array<[number, number]>> | undefined,
  rows: number,
  cols: number
): { spans: Record<string, Array<[number, number]>> | undefined; changed: boolean } {
  const maxRows = Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0
  const maxCols = Number.isFinite(cols) ? Math.max(0, Math.floor(cols)) : 0
  const entries = Object.entries(spans ?? {})
  if (entries.length === 0) return { spans: undefined, changed: false }
  // 表被缩到没有行或没有列：跨度全部作废（有跨度才算动过）
  if (maxRows === 0 || maxCols === 0) return { spans: undefined, changed: true }

  const out: Record<string, Array<[number, number]>> = {}
  let changed = false
  for (const [colKey, list] of entries) {
    const c = Number.parseInt(colKey, 10)
    // 列被删掉（或列号本身非法）：整列跨度丢弃
    if (!Number.isInteger(c) || c < 0 || c >= maxCols || !Array.isArray(list)) {
      changed = true
      continue
    }
    const kept: Array<[number, number]> = []
    for (const span of list) {
      const start = span?.[0]
      const len = span?.[1]
      const end = Number.isFinite(start) && Number.isFinite(len) ? Math.min(maxRows, start + len) : 0
      // 起点在表外、或可用行数不足 2：这处合并已经没有意义
      if (!Number.isFinite(start) || start < 0 || start >= maxRows || end - start < 2) {
        changed = true
        continue
      }
      if (end - start !== len) changed = true
      kept.push([start, end - start])
    }
    if (kept.length > 0) out[colKey] = kept
  }
  if (Object.keys(out).length === 0) return { spans: undefined, changed: true }
  return { spans: out, changed }
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

/** 合并块数量（UI 上给「已合并 N 处」用） */
export function countVerticalMerges(merges: readonly (readonly TableMergeCell[])[]): number {
  let n = 0
  for (const row of merges) for (const cell of row) if (cell.rowSpan > 1) n++
  return n
}
