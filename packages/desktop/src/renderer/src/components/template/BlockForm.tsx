/**
 * 右栏的一张内容块卡片：类型、锁档位、按类型的初始内容字段，加上块自己的增删移。
 * 字段写的就是模板 JSON 的字段（text 用 content、code 用 language + content、
 * 表格用 caption/rows/cols/headers/data/mergeVertical、列表用 items），不做二次命名。
 */
import type { JSX } from 'react'
import { BLOCK_TYPE_NAMES } from '@documentor/core/blocks'
import { BLOCK_TYPE_BADGES, BLOCK_TYPE_LABELS, CODE_LANGUAGES, CODE_LANGUAGE_LABELS } from '../editor/blockTypes'
import type { TemplateIssueDto } from '../../../../shared/project'
import { CheckField, Field, IssueLines, LinesAreaField, NumberField, TextAreaField, TextField } from './fields'
import {
  arrayToLines,
  blockLock,
  blockType,
  headersToText,
  linesToArray,
  num,
  rawBlockLock,
  rowsToText,
  str,
  textToHeaders,
  textToRows,
  unknownKeys,
  BLOCK_FIELDS,
  type TemplateObject
} from './templateDoc'

const LOCK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '不锁' },
  { value: 'type', label: '锁类型（type）' },
  { value: 'keep', label: '锁定保留（keep）' },
  { value: 'readonly', label: '只读（readonly）' }
]

/** 档位的含义：说清"对用户意味着什么"，一句话 */
function lockHint(lock: string): string {
  switch (lock) {
    case 'type':
      return '内容可改，类型不能改'
    case 'keep':
      return '内容可改，不能删除、不能移动，类型也不能改'
    case 'readonly':
      return '内容与类型都由模板给定'
    default:
      return '不锁：用户可改内容、类型，也可删除或移动'
  }
}

function lockTag(lock: string): string | null {
  if (lock === 'readonly') return '只读'
  if (lock === 'keep' || lock === 'type') return '锁定'
  return null
}

export interface BlockFormProps {
  block: TemplateObject
  index: number
  count: number
  /** 已经过滤到这个块下面的校验结论 */
  issues: TemplateIssueDto[]
  onPatch: (patch: TemplateObject) => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
}

export function BlockForm(props: BlockFormProps): JSX.Element {
  const { block, index, count, issues, onPatch, onMove, onRemove } = props
  const type = blockType(block)
  const lock = blockLock(block)
  const unknownLock = rawBlockLock(block)
  const typeLabel = (BLOCK_TYPE_LABELS as Record<string, string>)[type] ?? type
  const extra = unknownKeys(block, BLOCK_FIELDS)
  const tag = lockTag(lock)

  const typeOptions = BLOCK_TYPE_NAMES.map((name) => ({
    value: name as string,
    label: `${BLOCK_TYPE_LABELS[name]}（${name}）`
  }))
  if (type === '') {
    // 没写 type 的块：下拉里得有它自己那一项，否则控件显示成空白
    typeOptions.unshift({ value: '', label: '（未写类型）' })
  } else if (!(BLOCK_TYPE_NAMES as readonly string[]).includes(type)) {
    typeOptions.push({ value: type, label: `${type}（不认识）` })
  }
  const lockOptions = [...LOCK_OPTIONS]
  if (unknownLock !== null) {
    lockOptions.push({ value: unknownLock, label: `${unknownLock}（不认识）` })
  }

  const cols = num(block['cols'], 0)
  const headers = Array.isArray(block['headers']) ? (block['headers'] as unknown[]) : []
  const rows = Array.isArray(block['data']) ? (block['data'] as unknown[]) : []
  const colMismatch = type === 'table' && headers.length !== cols

  return (
    <article className={`tpl-block${issues.some((i) => i.level === 'error') ? ' has-error' : ''}`}>
      <header className="tpl-block-head">
        <span className="tpl-block-badge">
          {(BLOCK_TYPE_BADGES as Record<string, string>)[type] ?? '?'}
        </span>
        <span className="tpl-block-title">
          {index + 1}. {typeLabel || '（未写类型）'}
        </span>
        {tag && <span className="tpl-tag">{tag}</span>}
        <div className="tpl-block-actions">
          <button
            type="button"
            className="tpl-mini"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            title="上移"
          >
            上移
          </button>
          <button
            type="button"
            className="tpl-mini"
            onClick={() => onMove(1)}
            disabled={index === count - 1}
            title="下移"
          >
            下移
          </button>
          <button
            type="button"
            className="tpl-mini tpl-danger"
            onClick={onRemove}
            title="删除这个内容块"
          >
            删除
          </button>
        </div>
      </header>
      <div className="tpl-block-body">
        <div className="tpl-grid-2">
          <Field label="类型">
            <select
              className="tpl-select"
              value={type}
              onChange={(event) => onPatch({ type: event.target.value })}
            >
              {typeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="锁档位">
            <select
              className="tpl-select"
              value={unknownLock ?? lock}
              onChange={(event) => {
                const value = event.target.value
                // 不锁就是把 lock 这个键去掉，与模板里"没写过"完全一致
                onPatch({ lock: value === '' ? undefined : value })
              }}
            >
              {lockOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="tpl-note">
          {unknownLock !== null
            ? `lock 取值「${unknownLock}」不认识，程序按不锁处理`
            : lockHint(lock)}
        </p>

        {type === 'text' && (
          <TextAreaField
            label="初始文本（content）"
            value={str(block['content'])}
            rows={4}
            onChange={(value) => onPatch({ content: value })}
          />
        )}

        {(type === 'orderedList' || type === 'unorderedList') && (
          <LinesAreaField
            label="初始项（items）"
            hint="一行一条"
            value={arrayToLines(Array.isArray(block['items']) ? (block['items'] as unknown[]) : [])}
            rows={5}
            onChange={(value) => onPatch({ items: linesToArray(value) })}
          />
        )}

        {type === 'table' && (
          <>
            <TextField
              label="表名（caption）"
              value={str(block['caption'])}
              onChange={(value) => onPatch({ caption: value })}
            />
            <div className="tpl-grid-3">
              <NumberField
                label="列数（cols）"
                value={cols}
                onChange={(value) => onPatch({ cols: value })}
              />
              <NumberField
                label="行数（rows）"
                value={num(block['rows'], 0)}
                onChange={(value) => onPatch({ rows: value })}
              />
              <Field label="实际行数">
                <span className="tpl-readonly">{rows.length} 行</span>
              </Field>
            </div>
            {colMismatch && (
              <button
                type="button"
                className="tpl-mini tpl-inline-action"
                onClick={() => onPatch({ cols: headers.length })}
              >
                按表头把列数改成 {headers.length}
              </button>
            )}
            <TextField
              label="表头（headers）"
              hint="用 | 分隔"
              value={headersToText(headers)}
              placeholder="序号 | 名称 | 说明"
              onChange={(value) => onPatch({ headers: textToHeaders(value) })}
            />
            <LinesAreaField
              label="数据（data）"
              hint="一行一行，单元格用 | 分隔"
              rows={5}
              value={rowsToText(rows)}
              onChange={(value) => onPatch({ data: textToRows(value) })}
            />
            <CheckField
              label="同列相同值纵向合并（mergeVertical）"
              checked={block['mergeVertical'] === true}
              onChange={(checked) =>
                onPatch({ mergeVertical: checked ? true : undefined })
              }
            />
          </>
        )}

        {type === 'code' && (
          <>
            <TextField
              label="语言（language）"
              mono
              value={str(block['language'])}
              placeholder={CODE_LANGUAGES[0]}
              onChange={(value) => onPatch({ language: value })}
            />
            <p className="tpl-note">
              常用语言：
              {CODE_LANGUAGES.map((code) => CODE_LANGUAGE_LABELS[code] ?? code).join('、')}
            </p>
            <TextAreaField
              label="初始代码（content）"
              mono
              rows={5}
              value={str(block['content'])}
              onChange={(value) => onPatch({ content: value })}
            />
          </>
        )}

        {type === 'mermaid' && (
          <>
            <TextField
              label="图题（caption）"
              value={str(block['caption'])}
              onChange={(value) => onPatch({ caption: value })}
            />
            <TextAreaField
              label="图（content）"
              mono
              rows={6}
              value={str(block['content'])}
              onChange={(value) => onPatch({ content: value })}
            />
          </>
        )}

        {type === 'image' && (
          <>
            <TextField
              label="图片路径（content）"
              mono
              hint="工程内相对路径，可留空"
              value={str(block['content'])}
              onChange={(value) => onPatch({ content: value })}
            />
            <TextField
              label="图题（caption）"
              value={str(block['caption'])}
              onChange={(value) => onPatch({ caption: value })}
            />
          </>
        )}

        {type === 'formula' && (
          <TextAreaField
            label="公式（content）"
            mono
            rows={3}
            value={str(block['content'])}
            onChange={(value) => onPatch({ content: value })}
          />
        )}

        {extra.length > 0 && (
          <p className="tpl-note">
            这份块里还有界面不管的字段：{extra.join('、')}（原样保留）
          </p>
        )}

        <IssueLines issues={issues} />
      </div>
    </article>
  )
}

export default BlockForm
