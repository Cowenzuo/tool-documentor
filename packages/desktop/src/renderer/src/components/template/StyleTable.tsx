/**
 * 样式对照表（PLAN-11 批次 3）：一份 stylemap 的逐行视图，也是这一批唯一能改样式的地方。
 *
 * 它占中栏与右栏两栏的位置（`grid-column: 3 / -1`）：一行有五列，挤在 292px 的树栏里没法看。
 * 每行一个逻辑键，回答四件事——**这一行管什么（用途）、现在指向谁（映射）、
 * 这份结构模板要不要它（必需）、没配或配错了会怎样（状态与回退）**。
 *
 * 事实与结论都由外面算好传进来（`rows` 按草稿实时算、`issues` 跑的是主进程那份规则），
 * 这里只负责显示与"改了哪一行"的回调——规则不在这份组件里。
 */
import type { JSX } from 'react'
import type {
  SkeletonStyleDto,
  StyleMapRowDto,
  TemplateIssueDto,
  TemplateStyleReadResult
} from '../../../../shared/project'
import { CloseIcon } from '../icons'
import type { TemplateObject } from './templateDoc'
import { CAPTION_MODES, captionNumberingOf, type CaptionKind } from './styleDraft'
import { issueWhereForStyle, styleStatusLabel, styleStatusTone, skeletonStyleTip } from './templateStyleDoc'
import type { TemplateEditorStatus } from './useTemplateEditor'

interface StyleTableProps {
  status: TemplateEditorStatus
  result: TemplateStyleReadResult | null
  /** 草稿（题注编号那一段按它显示；映射那一列按 rows 里的 styleId 显示） */
  doc: TemplateObject | null
  /** 按草稿实时算出来的行 */
  rows: StyleMapRowDto[]
  /** 按草稿跑同一套规则得到的结论 */
  issues: TemplateIssueDto[]
  /** 这些结论是主进程给的还是本地即时算的（浮层提示里要说清） */
  issuesFromServer: boolean
  onMap: (key: string, styleId: string | null) => void
  onCaptionMode: (kind: CaptionKind, mode: string | null) => void
  onChapterStyleName: (level: string, name: string | null) => void
}

/** 表头三列：逻辑键、映射、状态。用途与必需不占列：用途进键的悬停，必需只在缺的时候由状态列说 */
const COLUMNS = ['逻辑键', '当前映射', '状态与说明'] as const

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

export function StyleTable({
  status,
  result,
  doc,
  rows,
  issues,
  issuesFromServer,
  onMap,
  onCaptionMode,
  onChapterStyleName
}: StyleTableProps): JSX.Element {
  if (!result || !doc) {
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

  const docxFolder = typeof doc['docxFolder'] === 'string' ? doc['docxFolder'] : ''
  const name = typeof doc['name'] === 'string' && doc['name'] !== '' ? doc['name'] : result.id
  const byId = new Map(result.skeletonStyles.map((style) => [style.styleId, style]))
  const errors = issues.filter((i) => i.level === 'error').length
  const warnings = issues.length - errors
  const groups = groupRows(rows)
  const problemRows = rows.filter((row) => row.status !== 'ok' && row.status !== 'unset')
  /** 键 → 该键当前指向的 styleId（说明"回退到 body"时顺带看那个键配没配） */
  const fallbackIds = new Map(rows.map((row) => [row.key, row.styleId]))
  const cn = captionNumberingOf(doc)
  const chapterNames = (cn && typeof cn['chapterStyleNames'] === 'object'
    ? cn['chapterStyleNames']
    : null) as Record<string, unknown> | null
  const chapterLevels = Object.keys(chapterNames ?? {}).sort((a, b) => Number(a) - Number(b))
  const fieldMode = cn?.['table'] === 'field' || cn?.['figure'] === 'field'
  /**
   * 骨架里有、这份表没人用的样式：**按草稿算**（刚配上的立刻从清单里消失），
   * 否则改一行之后那份清单还是旧的，看着像没生效。
   */
  const usedIds = new Set(rows.map((row) => row.styleId).filter((id) => id !== ''))
  const unusedStyleIds = result.skeletonStyles
    .map((style) => style.styleId)
    .filter((id) => !usedIds.has(id))

  return (
    <section className="tpl-col tpl-col-map" aria-label="样式对照表">
      <header className="tpl-col-head">
        <h2>样式对照表</h2>
        {/* 栏头只说"这一栏是什么"：名字 + 骨架目录（悬停看全路径） */}
        <span className="tpl-col-hint" title={result.skeletonPath}>
          {name}
        </span>
        {/* 两条提示靠右：有活干、会影响别人。正常时这一头什么都不显示 */}
        {(problemRows.length > 0 || result.usedBy.length > 1) && (
          <span className="tpl-col-facts">
            {problemRows.length > 0 && (
              <span className="tpl-map-bad">待修正 {problemRows.length} 行</span>
            )}
            {result.usedBy.length > 1 && (
              <span
                title={result.usedBy
                  .map((u) => `${u.name}${u.isDefault ? '（默认）' : ''}`)
                  .join('、')}
              >
                共用 {result.usedBy.length} 份
              </span>
            )}
          </span>
        )}
      </header>

      <div className="tpl-col-body tpl-map-body">
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
                styles={result.skeletonStyles}
                byId={byId}
                fallbackIds={fallbackIds}
                onMap={onMap}
              />
            ))}
          </tbody>
        </table>

        {/* 题注编号：三种方式按题注分别选；field 模式还要章节样式名（Word 只认界面上的本地化名） */}
        <div className="tpl-caption">
          <h3>题注编号</h3>
          <div className="tpl-caption-row">
            {(['table', 'figure'] as const).map((kind) => (
              <label className="tpl-field tpl-caption-field" key={kind}>
                <span className="tpl-field-label">{kind === 'table' ? '表题' : '图题'}</span>
                <select
                  className="tpl-select"
                  value={String(cn?.[kind] ?? 'auto')}
                  disabled={status !== 'ready'}
                  onChange={(event) => onCaptionMode(kind, event.target.value)}
                >
                  {CAPTION_MODES.map((mode) => (
                    <option key={mode.value} value={mode.value} title={mode.why}>
                      {mode.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          {fieldMode && (
            <div className="tpl-caption-names">
              <div className="tpl-caption-names-head">
                <span className="tpl-field-label">章节样式名</span>
                <span className="tpl-count">STYLEREF 引用的样式名 · 中文 Word 为「标题 N」</span>
                <button
                  type="button"
                  className="tpl-mini"
                  title="新增一级 · 默认「标题 N」"
                  onClick={() => {
                    const used = new Set(chapterLevels.map((level) => Number(level)))
                    let level = 2
                    while (used.has(level)) level += 1
                    onChapterStyleName(String(level), `标题 ${level}`)
                  }}
                >
                  加一层
                </button>
              </div>
              {chapterLevels.length === 0 ? (
                <p className="tpl-note">
                  未配章节样式名 · 回退「标题 N」，英文版 Word 算不出章节号
                </p>
              ) : (
                <ul className="tpl-caption-name-list">
                  {chapterLevels.map((level) => (
                    <li key={level}>
                      <span className="tpl-count">{level} 级标题</span>
                      <input
                        className="tpl-input"
                        value={String(chapterNames?.[level] ?? '')}
                        placeholder={`标题 ${level}`}
                        onChange={(event) => onChapterStyleName(level, event.target.value)}
                      />
                      <button
                        type="button"
                        className="tpl-icon-btn"
                        title="删除后按「标题 N」"
                        aria-label={`删掉 ${level} 级标题的章节样式名`}
                        onClick={() => onChapterStyleName(level, null)}
                      >
                        <CloseIcon size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* 骨架里有、这份对照表没人用的样式：顺手看看有没有漏配 */}
        <details className="tpl-map-unused">
          <summary>
            {unusedStyleIds.length === 0
              ? '样式已全部使用'
              : `未使用 ${unusedStyleIds.length} 条`}
          </summary>
          {unusedStyleIds.length > 0 && (
            <ul className="tpl-map-unused-list">
              {unusedStyleIds.map((styleId) => {
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
        {/* 校验结论不在这里印第二遍：页脚状态栏常驻同一份结论，点开就是按位置归堆的原话 */}
      </div>
    </section>
  )
}

/** 一个分区的行：分区名占一整行，下面才是这一区的逻辑键 */
function GroupRows({
  group,
  rows,
  styles,
  byId,
  fallbackIds,
  onMap
}: {
  group: string
  rows: StyleMapRowDto[]
  /** 骨架里的样式（映射下拉的选项） */
  styles: SkeletonStyleDto[]
  byId: Map<string, SkeletonStyleDto>
  /** 键 → 该键当前的 styleId（回退目标也要看那个键配没配） */
  fallbackIds: Map<string, string>
  onMap: (key: string, styleId: string | null) => void
}): JSX.Element {
  return (
    <>
      <tr className="tpl-map-group">
        <th scope="colgroup" colSpan={COLUMNS.length}>
          {group}
        </th>
      </tr>
      {rows.map((row) => {
        const target = byId.get(row.styleId)
        const fallbackId = row.fallback === null ? '' : (fallbackIds.get(row.fallback) ?? '')
        return (
          <tr
            key={row.key}
            className={`tpl-map-row is-${styleStatusTone(row.status)}${row.read ? '' : ' is-inert'}`}
            title={row.read ? undefined : '程序不读 · 列表各层只取第 1 档'}
          >
            <th scope="row" className="tpl-map-key">
              <code className="tpl-mono" title={row.usage}>
                {row.key}
              </code>
            </th>
            <td className="tpl-map-target">
              {/* 映射就是这一列的活：选骨架里的一条样式；「（不配）」= 把这一项从 styleMap 里删掉。
                  选中项的说明只说下拉里看不到的（类型、字号、编号）——
                  "没配 / 骨架里没有"这种话选项文字与状态列都已经写着 */}
              <select
                className="tpl-select tpl-map-select"
                value={row.styleId}
                title={target ? skeletonStyleTip(target) : undefined}
                onChange={(event) => onMap(row.key, event.target.value === '' ? null : event.target.value)}
              >
                <option value="">（不配）</option>
                {styles.map((style) => (
                  <option key={style.styleId} value={style.styleId}>
                    {style.name === '' ? style.styleId : `${style.name}（${style.styleId}）`}
                  </option>
                ))}
                {/* 文件里配了一条骨架里没有的：留着它，别让下拉悄悄把值改掉 */}
                {row.styleId !== '' && !byId.has(row.styleId) && (
                  <option value={row.styleId}>{`${row.styleId}（样式文件里没有）`}</option>
                )}
              </select>
            </td>
            <td className="tpl-map-status">
              <span className={`tpl-map-state is-${styleStatusTone(row.status)}`}>
                {styleStatusLabel(row.status)}
              </span>
              {/* 说明只在"要动手"时写：正常与配了不生效都不说第二遍 */}
              {row.status === 'unset' ? (
                <span className="tpl-map-why">
                  {row.fallback === null ? '按 Word 默认样式' : `回退 ${row.fallback}`}
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
