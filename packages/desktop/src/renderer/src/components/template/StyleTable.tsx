/**
 * 样式对照表（PLAN-11 批次 3）：一份 stylemap 的逐行视图。
 *
 * 它占中栏与右栏两栏的位置（`grid-column: 3 / -1`）：一行有五列，挤在 292px 的树栏里没法看。
 * 每行一个逻辑键，回答四件事——**这一行管什么（用途）、现在指向谁（映射）、
 * 这份结构模板要不要它（必需）、没配或配错了会怎样（状态与回退）**。
 *
 * 事实来源全在主进程：`TemplateStyleReadResult` 里的 rows / skeletonStyles / usedBy / issues
 * 由 `readStyle` 算好送来，界面不重算规则（保存前的闸门仍在主进程的 validateStyleTemplate）。
 */
import type { JSX } from 'react'
import type {
  SkeletonStyleDto,
  StyleMapRowDto,
  TemplateStyleReadResult
} from '../../../../shared/project'
import { issueWhereForStyle, styleStatusLabel, styleStatusTone, skeletonStyleTip } from './templateStyleDoc'
import type { TemplateEditorStatus } from './useTemplateEditor'

interface StyleTableProps {
  status: TemplateEditorStatus
  result: TemplateStyleReadResult | null
}

/** 表头五列：逻辑键、用途、映射、必需、状态（宽度写在 CSS 里） */
const COLUMNS = ['逻辑键', '用途', '当前映射', '必需', '状态与回退'] as const

/** 一行分到哪个分区（rows 已按显示顺序排好，这里只做分段） */
function groupRows(rows: readonly StyleMapRowDto[]): Array<{ group: string; rows: StyleMapRowDto[] }> {
  const out: Array<{ group: string; rows: StyleMapRowDto[] }> = []
  for (const row of rows) {
    const last = out[out.length - 1]
    if (last && last.group === row.group) last.rows.push(row)
    else out.push({ group: row.group, rows: [row] })
  }
  return out
}

export function StyleTable({ status, result }: StyleTableProps): JSX.Element {
  if (!result) {
    return (
      <section className="tpl-col tpl-col-map" aria-label="样式对照表">
        <header className="tpl-col-head">
          <h2>样式对照表</h2>
        </header>
        <div className="tpl-col-body">
          <p className="tpl-empty">
            {status === 'ready' ? '没有打开样式模板' : '正在读取模板目录…'}
          </p>
        </div>
      </section>
    )
  }

  const doc = result.doc
  const docxFolder = typeof doc['docxFolder'] === 'string' ? doc['docxFolder'] : ''
  const name = typeof doc['name'] === 'string' && doc['name'] !== '' ? doc['name'] : result.id
  const byId = new Map(result.skeletonStyles.map((style) => [style.styleId, style]))
  const errors = result.issues.filter((i) => i.level === 'error').length
  const warnings = result.issues.length - errors
  const groups = groupRows(result.rows)
  const problemRows = result.rows.filter((row) => row.status !== 'ok' && row.status !== 'unset')
  /** 键 → 该键当前指向的 styleId（说明"回退到 body"时顺带看那个键配没配） */
  const fallbackIds = new Map(result.rows.map((row) => [row.key, row.styleId]))

  return (
    <section className="tpl-col tpl-col-map" aria-label="样式对照表">
      <header className="tpl-col-head">
        <h2>样式对照表</h2>
        {/* 栏头只说"这一栏是什么"：名字 + 骨架目录（悬停看全路径）。
            这份表有多大在顶栏说，文件与文件键在下面那一行说，同一件事不说两遍 */}
        <span className="tpl-col-hint" title={result.skeletonPath}>
          {name}
        </span>
      </header>

      <div className="tpl-col-body tpl-map-body">
        <div className="tpl-map-meta">
          <div className="tpl-map-meta-line">
            <code className="tpl-mono">styles/{result.id}/{result.file}</code>
            <span className="tpl-count">
              结构模板引用它时写的是文件键「{result.fileKey}」
            </span>
          </div>
          <div className="tpl-map-meta-line">
            <span className="tpl-count">
              骨架 {docxFolder === '' ? '（stylemap 里没写 docxFolder）' : docxFolder}
            </span>
            {/* 共用影响面：同一份映射可能被多份结构模板引用，改它之前先看清有谁在用 */}
            <span className="tpl-count">
              {result.usedBy.length === 0
                ? '还没有结构模板引用这份对照表'
                : `共 ${result.usedBy.length} 份结构模板在用：${result.usedBy
                    .map((u) => `${u.name}${u.isDefault ? '（默认）' : ''}`)
                    .join('、')}`}
            </span>
          </div>
          {problemRows.length > 0 && (
            <div className="tpl-map-meta-line">
              <span className="tpl-count tpl-map-bad">
                有 {problemRows.length} 行要处理：{problemRows.map((row) => row.key).join('、')}
              </span>
            </div>
          )}
        </div>

        <table className="tpl-map">
          <thead>
            <tr>
              {COLUMNS.map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <GroupRows
                key={group.group}
                group={group.group}
                rows={group.rows}
                byId={byId}
                fallbackIds={fallbackIds}
              />
            ))}
          </tbody>
        </table>

        {/* 骨架里有、这份对照表没人用的样式：顺手看看有没有漏配 */}
        <details className="tpl-map-unused">
          <summary>
            {result.unusedStyleIds.length === 0
              ? '骨架里的样式都用上了'
              : `骨架里有 ${result.unusedStyleIds.length} 条样式这份对照表没人用`}
          </summary>
          {result.unusedStyleIds.length > 0 && (
            <ul className="tpl-map-unused-list">
              {result.unusedStyleIds.map((styleId) => {
                const style = byId.get(styleId)
                return (
                  <li key={styleId}>
                    <code className="tpl-mono">{styleId}</code>
                    {style && style.name !== '' && style.name !== styleId && (
                      <span className="tpl-count">（{style.name}）</span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </details>

        {/* 校验结论的原话：样式这一侧没有"节点详情"那样的落点，原话就摆在这里 */}
        <div className="tpl-map-issues">
          <h3>
            校验结论
            <span className="tpl-count">
              {errors} 个错误 · {warnings} 处提示
            </span>
          </h3>
          {result.issues.length === 0 ? (
            <p className="tpl-note">没有结论：这份对照表与引用它的结构模板对得上。</p>
          ) : (
            <ul className="tpl-map-issue-list">
              {result.issues.map((issue, index) => (
                <li
                  key={`${issue.rule}-${index}`}
                  className={`tpl-map-issue is-${issue.level}`}
                  title={issue.rule}
                >
                  {/* 位置给人读的话（映射 heading.1 / 结构「甲结构」的覆盖），原始 path 在标题里 */}
                  <span className="tpl-map-issue-where" title={issue.path}>
                    {issueWhereForStyle(issue.path)}
                  </span>
                  <span className="tpl-map-issue-text">{issue.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

/** 一个分区的行：分区名占一整行，下面才是这一区的逻辑键 */
function GroupRows({
  group,
  rows,
  byId,
  fallbackIds
}: {
  group: string
  rows: StyleMapRowDto[]
  byId: Map<string, SkeletonStyleDto>
  /** 键 → 该键当前的 styleId（回退目标也要看那个键配没配） */
  fallbackIds: Map<string, string>
}): JSX.Element {
  return (
    <>
      <tr className="tpl-map-group">
        <th scope="colgroup" colSpan={COLUMNS.length}>
          {group} · {rows.length} 个键
        </th>
      </tr>
      {rows.map((row) => {
        const target = byId.get(row.styleId)
        const fallbackId = row.fallback === null ? '' : (fallbackIds.get(row.fallback) ?? '')
        return (
          <tr key={row.key} className={`tpl-map-row is-${styleStatusTone(row.status)}`}>
            <th scope="row" className="tpl-map-key">
              <code className="tpl-mono">{row.key}</code>
              {/* 「不读」是键自己的属性（不是这一行配得对不对），所以挂在键这一格 */}
              {!row.read && (
                <span className="tpl-count" title="程序不读这个键：列表各层都用第 1 档">
                  不读
                </span>
              )}
            </th>
            <td className="tpl-map-usage">{row.usage}</td>
            <td className="tpl-map-target">
              {row.styleId === '' ? (
                <span className="tpl-count">（不配）</span>
              ) : (
                <>
                  <code className="tpl-mono">{row.styleId}</code>
                  {target && (
                    <span className="tpl-count" title={skeletonStyleTip(target)}>
                      {target.name || '（没写样式名）'}
                    </span>
                  )}
                </>
              )}
            </td>
            <td className="tpl-map-required">
              {row.required ? (
                <span
                  className={`tpl-badge ${row.status === 'missing' ? 'tpl-badge-error' : ''}`}
                  title={`${row.requiredBy.join('、')} 用到了它`}
                >
                  必需
                </span>
              ) : (
                <span className="tpl-count">—</span>
              )}
            </td>
            <td className="tpl-map-status">
              <span className={`tpl-map-state is-${styleStatusTone(row.status)}`}>
                {styleStatusLabel(row.status)}
              </span>
              {/* 正常那一行不说第二遍"指向谁"（左边两列写着）；没配 / 配错 / 没核对才要说为什么 */}
              {row.status === 'unset' ? (
                <span className="tpl-map-why">
                  {row.fallback === null
                    ? '没人需要它，用到时按 Word 默认样式输出'
                    : `程序回退用 ${row.fallback}${fallbackId === '' ? '（那个键也没配）' : ''}`}
                </span>
              ) : row.status === 'inert' ? null : row.status === 'ok' ? null : (
                <span className="tpl-map-why">{row.message}</span>
              )}
            </td>
          </tr>
        )
      })}
    </>
  )
}

export default StyleTable
