/**
 * 右栏的一张内容块卡片：类型、锁、按类型的初始内容字段，加上块自己的增删移。
 * 常驻文字只留必要的：字段标签用人话，JSON 字段名与解释走悬停提示（jsonTip）；
 * 「不锁」不写一行说明——绝大多数块都是不锁，那一行纯粹是噪音。
 */
import type { JSX } from 'react'
import { BLOCK_TYPE_NAMES } from '@documentor/core/blocks'
import { BLOCK_TYPE_BADGES, BLOCK_TYPE_LABELS, CODE_LANGUAGES, CODE_LANGUAGE_LABELS } from '../editor/blockTypes'
import type { TemplateIssueDto } from '../../../../shared/project'
import {
  CheckField,
  Field,
  IssueLines,
  LinesAreaField,
  NumberField,
  TextAreaField,
  TextField,
  jsonTip
} from './fields'
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
  { value: 'type', label: '只锁类型' },
  { value: 'keep', label: '锁删除与移动' },
  { value: 'readonly', label: '只读（连内容）' }
]

/** 档位对用户意味着什么，一句话；「不锁」不写（那是绝大多数，写出来只是噪音） */
function lockHint(lock: string): string {
  switch (lock) {
    case 'type':
      return '内容可改，类型不能改'
    case 'keep':
      return '内容可改，不能删除、不能移动'
    case 'readonly':
      return '内容与类型都由模板给定'
    default:
      return ''
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
          <Field label="类型" tip={jsonTip('type')}>
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
          <Field
            label="锁"
            tip={jsonTip('lock', 'type 只锁类型 / keep 锁删除与移动 / readonly 连内容也锁')}
          >
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
        {(unknownLock !== null || lock !== '') && (
          <p className={`tpl-note${unknownLock !== null ? ' tpl-note-bad' : ''}`}>
            {unknownLock !== null
              ? `lock 取值「${unknownLock}」不认识，程序按不锁处理`
              : lockHint(lock)}
          </p>
        )}

        {type === 'text' && (
          <TextAreaField
            label="正文"
            tip={jsonTip('content')}
            rows={4}
            value={str(block['content'])}
            onChange={(value) => onPatch({ content: value })}
          />
        )}

        {(type === 'orderedList' || type === 'unorderedList') && (
          <LinesAreaField
            label="列表项"
            tip={jsonTip('items')}
            hint="一行一条"
            value={arrayToLines(Array.isArray(block['items']) ? (block['items'] as unknown[]) : [])}
            rows={5}
            onChange={(value) => onPatch({ items: linesToArray(value) })}
          />
        )}

        {type === 'table' && (
          <>
            <TextField
              label="表名"
              tip={jsonTip('caption')}
              value={str(block['caption'])}
              onChange={(value) => onPatch({ caption: value })}
            />
            <div className="tpl-grid-3">
              <NumberField
                label="列数"
                tip={jsonTip('cols')}
                value={cols}
                onChange={(value) => onPatch({ cols: value })}
              />
              <NumberField
                label="行数"
                tip={jsonTip('rows')}
                value={num(block['rows'], 0)}
                onChange={(value) => onPatch({ rows: value })}
              />
              <Field label="数据行数" tip={jsonTip('data')}>
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
              label="表头"
              tip={jsonTip('headers')}
              hint="用 | 分隔"
              value={headersToText(headers)}
              placeholder="序号 | 名称 | 说明"
              onChange={(value) => onPatch({ headers: textToHeaders(value) })}
            />
            <LinesAreaField
              label="数据"
              tip={jsonTip('data')}
              hint="每行一条，单元格用 | 分隔"
              rows={5}
              value={rowsToText(rows)}
              onChange={(value) => onPatch({ data: textToRows(value) })}
            />
            <CheckField
              label="纵向合并"
              tip={jsonTip(
                'mergeVertical',
                '同一列里连续且内容相同的单元格合并成一个；表头不参与，空串不合并'
              )}
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
              label="语言"
              tip={jsonTip(
                'language',
                `常用：${CODE_LANGUAGES.map((code) => CODE_LANGUAGE_LABELS[code] ?? code).join('、')}`
              )}
              mono
              value={str(block['language'])}
              placeholder={CODE_LANGUAGES[0]}
              onChange={(value) => onPatch({ language: value })}
            />
            <TextAreaField
              label="代码"
              tip={jsonTip('content')}
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
              label="图题"
              tip={jsonTip('caption')}
              value={str(block['caption'])}
              onChange={(value) => onPatch({ caption: value })}
            />
            <TextAreaField
              label="Mermaid 源码"
              tip={jsonTip('content')}
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
              label="图片路径"
              tip={jsonTip('content', '工程目录内的相对路径')}
              mono
              hint="可留空"
              value={str(block['content'])}
              onChange={(value) => onPatch({ content: value })}
            />
            <TextField
              label="图题"
              tip={jsonTip('caption')}
              value={str(block['caption'])}
              onChange={(value) => onPatch({ caption: value })}
            />
          </>
        )}

        {type === 'formula' && (
          <TextAreaField
            label="公式"
            tip={jsonTip('content')}
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
