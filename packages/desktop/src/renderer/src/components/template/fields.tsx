/**
 * 模板编辑页的输入控件与问题行。
 * 类名统一 `tpl-` 前缀、样式全部写在 template.css：这一页要能独立成自己的根
 * （PLAN-11 第 3 节），所以不借 editor.css 里的 `.be-*`，避免哪天编辑器不在这棵树里样式就没了。
 */
import { useEffect, useState, type JSX, type ReactNode } from 'react'
import type { TemplateIssueDto } from '../../../../shared/project'

export function Field({
  label,
  hint,
  tip,
  children
}: {
  label: string
  /** 常驻小字：只在"不写会填错"时才用，能进 tip 的都进 tip */
  hint?: string
  /** 悬停说明（一般放 JSON 字段名与它的含义），不占版面 */
  tip?: string
  children: ReactNode
}): JSX.Element {
  return (
    <label className="tpl-field">
      {/* 标签为空就不渲染标签行：折叠区里的字段靠 summary 说明自己是什么 */}
      {label !== '' && (
        <span className="tpl-field-label" title={tip ?? ''}>
          {label}
          {hint && <span className="tpl-field-hint">{hint}</span>}
        </span>
      )}
      {children}
    </label>
  )
}

/**
 * 字段名的悬停提示：**常驻标签只留人话**（标题、列数、锁），
 * JSON 里的键名与补充说明放这里——写模板的人需要它，但不是每分钟都要看。
 */
export function jsonTip(key: string, extra?: string): string {
  return extra ? `JSON 字段：${key}。${extra}` : `JSON 字段：${key}`
}

export function TextField({
  label,
  value,
  placeholder,
  hint,
  tip,
  mono,
  onChange
}: {
  label: string
  value: string
  placeholder?: string
  hint?: string
  tip?: string
  mono?: boolean
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <Field label={label} hint={hint} tip={tip}>
      <input
        className={`tpl-input${mono ? ' tpl-mono' : ''}`}
        value={value}
        placeholder={placeholder ?? ''}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  )
}

/**
 * 数字字段：输入过程中先把原文留在本地，失焦或变得可解析时才回写。
 * 直接由文档值驱动会在清空输入框时把 0 顶回去，光标与数字都会跳。
 */
export function NumberField({
  label,
  value,
  min,
  hint,
  tip,
  onChange
}: {
  label: string
  value: number
  min?: number
  hint?: string
  tip?: string
  onChange: (value: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (raw: string): void => {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed)) onChange(parsed)
    else onChange(min ?? 0)
  }
  return (
    <Field label={label} hint={hint} tip={tip}>
      <input
        className="tpl-input tpl-number"
        inputMode="numeric"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value)
          commit(event.target.value)
        }}
        onBlur={() => setDraft(String(value))}
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
  onChange
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  hint?: string
  tip?: string
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <Field label={label} hint={hint} tip={tip}>
      <select
        className="tpl-select"
        value={value}
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
  onChange
}: {
  label: string
  value: string
  placeholder?: string
  hint?: string
  tip?: string
  mono?: boolean
  rows?: number
  onChange: (value: string) => void
}): JSX.Element {
  return (
    <Field label={label} hint={hint} tip={tip}>
      <textarea
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
 * 「一行一条」的字段（列表项、表格数据）：编辑期间留着用户敲的原文，
 * 不拿规范化后的结果回写输入框——不然在末尾敲回车会被当场抹掉，光标也跟着跳。
 * 改动照旧即时生效（校验用的是规范化后的数组），失焦时再把显示对齐回数据。
 */
export function LinesAreaField({
  label,
  value,
  placeholder,
  hint,
  tip,
  rows,
  onChange
}: {
  label: string
  value: string
  placeholder?: string
  hint?: string
  tip?: string
  rows?: number
  onChange: (value: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])
  return (
    <Field label={label} hint={hint} tip={tip}>
      <textarea
        className="tpl-textarea tpl-mono"
        value={draft}
        rows={rows ?? 4}
        placeholder={placeholder ?? ''}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false)
          setDraft(value)
        }}
        onChange={(event) => {
          setDraft(event.target.value)
          onChange(event.target.value)
        }}
      />
    </Field>
  )
}

/** 一条校验结论：先说人话（message），再给出位置（path；位置可能很长，悬停看全） */
export function IssueLine({ issue }: { issue: TemplateIssueDto }): JSX.Element {
  return (
    <p className={`tpl-issue tpl-issue-${issue.level}`}>
      <span className="tpl-issue-text">{issue.message}</span>
      <code className="tpl-path" title={issue.path}>
        {issue.path}
      </code>
    </p>
  )
}

export function IssueLines({ issues }: { issues: TemplateIssueDto[] }): JSX.Element | null {
  if (issues.length === 0) return null
  return (
    <div className="tpl-issue-lines">
      {issues.map((issue, index) => (
        <IssueLine key={`${issue.rule}-${issue.path}-${index}`} issue={issue} />
      ))}
    </div>
  )
}
