/**
 * table-limits.ts — 表格的尺寸契约与完整性校验（core 唯一定义，界面与导出共用）。
 *
 * 为什么放在 core：上限原先写死在界面的 blockTypes.ts 里，导出侧完全不知道，
 * 外部工具也无法预检。放到 core 之后，界面、写入命令、导出可以引用同一组数字与同一条校验。
 */

/**
 * 界面上限（**不是数据合法性上限**）。
 *
 * 语义要分清：
 * - 这里管的是"界面愿意让你一次编辑多少"，属于可用性边界；
 * - 数据本身、导入、写入命令都不受它约束——超出上限的表照常保存、照常导出，
 *   只是界面会提示分批编辑。
 *
 * 取值依据：一屏编辑的实用规模。界面每格一个输入框，行 × 列就是 DOM 节点数，
 * 5 000 个输入框已经接近卡顿边缘；再大就该上虚拟滚动，而那属于另一件事。
 */
export const TABLE_MAX_ROWS = 500
export const TABLE_MAX_COLS = 30

/**
 * `rows` 的口径（曾经踩过，写清楚）：
 *
 * - **不含表头**：`headers` 是独立的一行，不算在 `rows` 里；
 * - **正文行数以 `data.length` 为准**。`rows` 允许与之不等：
 *   写入侧可能给 `data.length + 1`（把表头算进去的旧口径），
 *   于是把 `rows` 当成渲染依据会静默丢掉行尾数据。
 * - `rows` 缺省时按 `data.length` 理解。
 *
 * 因此渲染与导出都只看 `data`，`rows` 仅作为提示性元数据保留。
 */
export function bodyRowCount(rows: number | undefined, dataLength: number): number {
  void rows
  return dataLength
}

export interface TableShapeIssue {
  /** 问题定位，便于写入命令回报 */
  where: string
  /** 人读的原因 */
  reason: string
}

/**
 * 表格完整性校验（宽松版，供写入侧拦截明显错误，不阻断历史数据读取）。
 *
 * 检查项：
 * - `headers` 长度应等于 `cols`（长度 0 视为"无表头"，跳过检查）；
 * - 每个 `data` 行的列数应等于 `cols`；
 * - `rows` 若给出且明显小于 `data.length`，提示两者不一致（历史口径，不报错）。
 *
 * 返回空数组表示通过。
 */
export function checkTableShape(src: {
  cols: number
  rows?: number
  headers?: readonly string[]
  data?: readonly (readonly string[])[]
}): TableShapeIssue[] {
  const issues: TableShapeIssue[] = []
  const cols = Number(src.cols ?? 0)
  const headers = src.headers ?? []
  const data = src.data ?? []

  if (!Number.isInteger(cols) || cols <= 0) {
    issues.push({ where: 'cols', reason: `列数非法：${JSON.stringify(src.cols)}` })
    return issues
  }
  if (headers.length > 0 && headers.length !== cols) {
    issues.push({
      where: 'headers',
      reason: `表头 ${headers.length} 列与 cols ${cols} 不一致（表头要么留空，要么写满 cols 列）`
    })
  }
  for (const [i, row] of data.entries()) {
    if (row.length !== cols) {
      issues.push({
        where: `data[${i}]`,
        reason: `第 ${i + 1} 行 ${row.length} 列与 cols ${cols} 不一致`
      })
      if (issues.length >= 5) break // 只报前几条，避免刷屏
    }
  }
  if (typeof src.rows === 'number' && src.rows > 0 && src.rows < data.length) {
    issues.push({
      where: 'rows',
      reason:
        `rows ${src.rows} 小于正文行数 ${data.length}：rows 不含表头且渲染只认 data，` +
        `这里可能是把表头算进了 rows（旧口径），建议改为 ${data.length}`
    })
  }
  return issues
}
