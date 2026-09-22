/**
 * 模板编辑页的输入控件与问题行。
 * 类名统一 `tpl-` 前缀、样式全部写在 template.css：这一页要能独立成自己的根
 * （DESIGN-03），所以不借 editor.css 里的 `.be-*`，避免哪天编辑器不在这棵树里样式就没了。
 */
import type { JSX, ReactNode } from 'react'
import type { TemplateIssueDto } from '../../../../shared/project'

export function Field({
  label,
  hint,
  tip,
  extra,
  htmlFor,
  children
}: {
  label: string
  /** 常驻小字：只在"不写会填错"时才用，能进 tip 的都进 tip */
  hint?: string
  /** 悬停说明（一般放 JSON 字段名与它的含义），不占版面 */
  tip?: string
  /**
   * 跟在标签字样右边的零碎（例如节点那四个权限开关）：它们**搭在标签那一行的空处**，
   * 不占这一行的宽度份额——所以标控件不会被挤窄。
   * 给了 extra 就把外层从 `<label>` 换成 `<div>`（label 里套 label 是非法结构），
   * 同时用 htmlFor 把可访问名与控件连上。
   */
  extra?: ReactNode
  htmlFor?: string
  children: ReactNode
}): JSX.Element {
  const labelLine =
    label === '' ? null : (
      <span className="tpl-field-label" title={tip ?? ''}>
        {label}
        {hint && <span className="tpl-field-hint">{hint}</span>}
      </span>
    )
  if (extra !== undefined) {
    return (
      <div className="tpl-field">
        <div className="tpl-field-label-row">
          {htmlFor ? (
            <label className="tpl-field-label" htmlFor={htmlFor} title={tip ?? ''}>
              {label}
              {hint && <span className="tpl-field-hint">{hint}</span>}
            </label>
          ) : (
            labelLine
          )}
          {extra}
        </div>
        {children}
      </div>
    )
  }
  return (
    <label className="tpl-field">
      {/* 标签为空就不渲染标签行：折叠区里的字段靠 summary 说明自己是什么 */}
      {labelLine}
      {children}
    </label>
  )
}

/**
 * 字段名的悬停提示：形式是「字段 <键> · <事实>」——只点键名与取值，
 * 不写成句子，也不解释"为什么"。要解释的落点在常驻说明与校验原话里。
 */
export function jsonTip(key: string, extra?: string): string {
  return extra ? `字段 ${key} · ${extra}` : `字段 ${key}`
}

export function TextField({
  label,
  value,
  placeholder,
  hint,
  tip,
  mono,
  extra,
  htmlFor,
  onChange
}: {
  label: string
  value: string
  placeholder?: string
  hint?: string
  tip?: string
  mono?: boolean
  /** 搭在标签那一行右边的零碎（见 Field 的 extra） */
  extra?: ReactNode
  htmlFor?: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <Field label={label} hint={hint} tip={tip} extra={extra} htmlFor={htmlFor}>
      <input
        id={htmlFor}
        className={`tpl-input${mono ? ' tpl-mono' : ''}`}
        value={value}
        placeholder={placeholder ?? ''}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  )
}

export function CheckField({
  label,
  checked,
  tip,
  onChange
}: {
  label: string
  checked: boolean
  tip?: string
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className="tpl-switch" title={tip ?? ''}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export function SelectField({
  label,
  value,
  options,
  hint,
  tip,
  disabled,
  disabledWhy,
  onChange
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  hint?: string
  tip?: string
  disabled?: boolean
  /** 不能选的原因（只在 disabled 时用） */
  disabledWhy?: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <Field label={label} hint={hint} tip={disabled ? (disabledWhy ?? tip) : tip}>
      <select
        className="tpl-select"
        value={value}
        disabled={disabled === true}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

export function TextAreaField({
  label,
  value,
  placeholder,
  hint,
  tip,
  mono,
  rows,
  extra,
  htmlFor,
  onChange
}: {
  label: string
  value: string
  placeholder?: string
  hint?: string
  tip?: string
  mono?: boolean
  rows?: number
  /** 搭在标签那一行右端的零碎（见 Field 的 extra）：例如代码块的"语言" */
  extra?: ReactNode
  htmlFor?: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <Field label={label} hint={hint} tip={tip} extra={extra} htmlFor={htmlFor}>
      <textarea
        id={htmlFor}
        className={`tpl-textarea${mono ? ' tpl-mono' : ''}`}
        value={value}
        rows={rows ?? 3}
        placeholder={placeholder ?? ''}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  )
}

/**
 * 搭在标签行右端的小下拉：没有自己的标签行与下边距，靠 aria-label 说明自己是什么。
 * 用在这种地方：字段本身一眼认得出（"语言 cpp"），再给它一整行纯属浪费版面。
 */
export function InlineSelect({
  label,
  value,
  options,
  tip,
  onChange
}: {
  /** 可访问名：界面上不显示 */
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  tip?: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <select
      className="tpl-select tpl-select-inline"
      aria-label={label}
      title={tip ?? ''}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

/**
 * 一条校验结论：先说人话（message），再给出"在哪个节点"（where，人话的标题串）。
 *
 * 不显示 JSON 路径（`root.children[2].contentBlocks[0]`）：结构在中栏的树上一眼就能看到，
 * 那串下标只对直接改文件的人有意义。位置默认不显示——节点面板与内容块卡片上，
 * 上下文已经说明这条结论说的是哪个节点了，只有页脚那份总清单需要指路。
 */
export function IssueLine({
  issue,
  where,
  onJump
}: {
  issue: TemplateIssueDto
  where?: string | null
  onJump?: () => void
}): JSX.Element {
  return (
    <p className={`tpl-issue tpl-issue-${issue.level}`}>
      <span className="tpl-issue-text">{issue.message}</span>
      {where &&
        (onJump ? (
          <button type="button" className="tpl-issue-where" title="跳到该节点" onClick={onJump}>
            {where}
          </button>
        ) : (
          <span className="tpl-issue-where">{where}</span>
        ))}
    </p>
  )
}

export function IssueLines({
  issues,
  locate
}: {
  issues: TemplateIssueDto[]
  /** 每条结论"在哪个节点"：给了就在后面显示（可点着跳过去），不给就不显示位置 */
  locate?: (issue: TemplateIssueDto) => { where: string | null; onJump?: () => void }
}): JSX.Element | null {
  if (issues.length === 0) return null
  return (
    <div className="tpl-issue-lines">
      {issues.map((issue, index) => {
        const spot = locate ? locate(issue) : null
        return (
          <IssueLine
            key={`${issue.rule}-${issue.path}-${index}`}
            issue={issue}
            where={spot?.where ?? null}
            onJump={spot?.onJump}
          />
        )
      })}
    </div>
  )
}
