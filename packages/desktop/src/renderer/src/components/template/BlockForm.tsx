/**
 * 右栏的一张内容块卡片：收起时一行摘要（第几块、类型、锁、内容概览），展开才给字段。
 * 一张张摊开所有块的字段是"看着杂乱"的主要来源，所以按手风琴来（同时只开一张）。
 *
 * 展开时"这一块是什么"只在卡片头上说一次：类型与锁都做成头上的控件，标签字样去掉
 * （下拉里写着「表格」「只锁类型」，自己说明自己），锁的含义进悬停；正文区只剩内容字段。
 * 常驻文字只留必要的：JSON 字段名与解释走悬停提示（jsonTip）；「不锁」不写一行说明；
 * 「界面不管的字段」也不逐块声明（未知键保存时原样写回是全局约定），
 * 只有"字段名只差大小写"这种程序读不到、界面上又没位置的坑才提醒一句。
 */
import { type JSX } from 'react'
import { BLOCK_TYPE_NAMES } from '@documentor/core/blocks'
import { BLOCK_TYPE_LABELS, CODE_LANGUAGES, CODE_LANGUAGE_LABELS } from '../editor/blockTypes'
import { ChevronDownIcon } from '../icons'
import { MoveDownIcon, MoveUpIcon, TrashIcon } from './icons'
import type { TemplateIssueDto } from '../../../../shared/project'
import {
  CheckField,
  TextAreaField,
  TextField,
  InlineSelect,
  IssueLines,
  jsonTip
} from './fields'
import ListRows from './ListRows'
import TableGrid from './TableGrid'
import {
  blockLock,
  blockSummary,
  blockType,
  isPinnedLock,
  rawBlockLock,
  str,
  typoField,
  BLOCK_FIELDS,
  type TemplateObject
} from './templateDoc'

const LOCK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '不锁' },
  { value: 'type', label: '只锁类型' },
  { value: 'keep', label: '锁删除与移动' },
  { value: 'readonly', label: '只读' }
]

/** 档位对用户意味着什么，一句话（进锁下拉的悬停）；「不锁」不写（那是绝大多数） */
function lockHint(lock: string): string {
  switch (lock) {
    case 'type':
      return '内容可改，类型不能改'
    case 'keep':
      return '内容可改，不能删除、不能移动'
    case 'readonly':
      return '内容与类型都由模板给定'
    default:
      return '用户能改内容、能删能挪'
  }
}

function lockTag(lock: string): string | null {
  if (lock === 'readonly') return '只读'
  if (lock === 'keep' || lock === 'type') return '锁定'
  return null
}

/** 表头格子读成字符串数组（写坏的元素按空串看，校验那边另有话说） */
function headerCells(block: TemplateObject): string[] {
  const raw = block['headers']
  return Array.isArray(raw) ? raw.map((cell) => (cell === undefined || cell === null ? '' : String(cell))) : []
}

/** 数据格读成二维字符串数组；不是数组的行按空行看 */
function dataRows(block: TemplateObject): string[][] {
  const raw = block['data']
  if (!Array.isArray(raw)) return []
  return raw.map((row) =>
    Array.isArray(row) ? row.map((cell) => (cell === undefined || cell === null ? '' : String(cell))) : []
  )
}

/** 列表条目读成字符串数组（写坏的元素按空串看，校验那边另有话说） */
function itemCells(block: TemplateObject): string[] {
  const raw = block['items']
  return Array.isArray(raw) ? raw.map((item) => (item === undefined || item === null ? '' : String(item))) : []
}

export interface BlockFormProps {
  block: TemplateObject
  index: number
  count: number
  /** 卡片是否展开（手风琴，同时只开一张） */
  open: boolean
  onToggle: () => void
  /** 已经过滤到这个块下面的校验结论 */
  issues: TemplateIssueDto[]
  /** 相邻块是 keep/readonly：换位会把锁住的那一块挪走，所以这一块也不能往那边挪 */
  prevLocked: boolean
  nextLocked: boolean
  onPatch: (patch: TemplateObject) => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
  /** 右键卡片：上方插入 / 下方插入 / 复制这一块（挪与删是卡片上的按钮，菜单里不重复） */
  onOpenMenu: (x: number, y: number) => void
}

export function BlockForm(props: BlockFormProps): JSX.Element {
  const { block, index, count, open, onToggle, issues, prevLocked, nextLocked, onPatch, onMove, onRemove, onOpenMenu } =
    props
  const type = blockType(block)
  const lock = blockLock(block)
  const unknownLock = rawBlockLock(block)
  const typeLabel = (BLOCK_TYPE_LABELS as Record<string, string>)[type] ?? type
  const typo = typoField(block, BLOCK_FIELDS)
  const tag = lockTag(lock)
  const hasError = issues.some((i) => i.level === 'error')
  const hasWarn = !hasError && issues.some((i) => i.level === 'warn')
  /**
   * keep / readonly 的块锁住的是"必须存在 + 位置也不能变"：作者要挪要删，
   * 得先把这一块的锁改成不锁——同一条规矩在生成出来的工程里也一样守（写入侧 + 界面）。
   */
  const locked = isPinnedLock(lock)
  const unlockHint = `锁 ${lock} · 顺序固定，不可移动`
  const deleteLockedWhy = `锁 ${lock} · 不可删除`
  const moveUpTitle = locked
    ? unlockHint
    : prevLocked
      ? '上一块已锁 · 不可换位'
      : undefined
  const moveDownTitle = locked
    ? unlockHint
    : nextLocked
      ? '下一块锁着，换位会把它挪走'
      : undefined

  const typeOptions = BLOCK_TYPE_NAMES.map((name) => ({
    value: name as string,
    label: `${BLOCK_TYPE_LABELS[name]}（${name}）`
  }))
  if (type === '') {
    // 没写 type 的块：下拉里得有它自己那一项，否则控件显示成空白
    typeOptions.unshift({ value: '', label: '类型未写' })
  } else if (!(BLOCK_TYPE_NAMES as readonly string[]).includes(type)) {
    typeOptions.push({ value: type, label: `${type} · 不认识` })
  }
  const lockOptions = [...LOCK_OPTIONS]
  if (unknownLock !== null) {
    lockOptions.push({ value: unknownLock, label: `${unknownLock} · 不认识` })
  }
  const lockTip =
    unknownLock !== null
      ? `字段 lock · 取值「${unknownLock}」不认识，程序按不锁处理`
      : jsonTip('lock', lockHint(lock))

  return (
    <article
      className={`tpl-block${open ? ' is-open' : ''}${hasError ? ' has-error' : ''}`}
      onContextMenu={(event) => {
        event.preventDefault()
        onOpenMenu(event.clientX, event.clientY)
      }}
    >
      <header className="tpl-block-head">
        <button
          type="button"
          className="tpl-block-toggle"
          aria-expanded={open}
          aria-label={open ? '收起这一块' : '展开这一块'}
          onClick={onToggle}
        >
          <ChevronDownIcon size={13} className={open ? 'open' : ''} />
        </button>
        {open ? (
          <>
            {/* 展开时"这一块是什么"就在头上选：类型与锁各一个下拉，标签字样省掉 */}
            <span className="tpl-block-index">{index + 1}.</span>
            <select
              className="tpl-select tpl-select-inline"
              aria-label="这一块的类型"
              title={jsonTip('type')}
              value={type}
              onChange={(event) => onPatch({ type: event.target.value })}
            >
              {typeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              className={`tpl-select tpl-select-inline${unknownLock !== null ? ' tpl-select-bad' : ''}`}
              aria-label="这一块的锁"
              title={lockTip}
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
          </>
        ) : (
          <>
            {/* 类型只写一遍：原来左边还有个单字角标（「表」）和「1. 表格」重复 */}
            <button type="button" className="tpl-block-title" onClick={onToggle}>
              {index + 1}. {typeLabel || '类型未写'}
            </button>
            {tag && <span className="tpl-tag">{tag}</span>}
            {/* 收起时给一行摘要：不展开也知道这块是什么 */}
            <span className="tpl-block-summary">{blockSummary(block)}</span>
            {/* 收起时也要能看出这块有没有问题 */}
            {(hasError || hasWarn) && (
              <span
                className={`tpl-dot ${hasError ? 'tpl-dot-error' : 'tpl-dot-warn'}`}
                title={hasError ? '有错误' : '有提示'}
              />
            )}
          </>
        )}
        <div className="tpl-block-actions">
          <button
            type="button"
            className="tpl-icon-btn"
            title={moveUpTitle}
            aria-label="上移这一块"
            onClick={() => onMove(-1)}
            disabled={index === 0 || locked || prevLocked}
          >
            <MoveUpIcon />
          </button>
          <button
            type="button"
            className="tpl-icon-btn"
            title={moveDownTitle}
            aria-label="下移这一块"
            onClick={() => onMove(1)}
            disabled={index === count - 1 || locked || nextLocked}
          >
            <MoveDownIcon />
          </button>
          <button
            type="button"
            className="tpl-icon-btn tpl-danger"
            title={locked ? deleteLockedWhy : undefined}
            aria-label="删除这一块"
            onClick={onRemove}
            disabled={locked}
          >
            <TrashIcon />
          </button>
        </div>
      </header>
      {open && (
        <div className="tpl-block-body">
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
            <ListRows
              ordered={type === 'orderedList'}
              items={itemCells(block)}
              onChange={(items) => onPatch({ items })}
            />
          )}

          {type === 'table' && (
            <>
              <TextField
                label="表名"
                tip={jsonTip('caption')}
                value={str(block['caption'])}
                extra={
                  <CheckField
                    label="纵向合并"
                    tip={jsonTip('mergeVertical', '同列相邻同值合并 · 表头与空串除外')}
                    checked={block['mergeVertical'] === true}
                    onChange={(checked) => onPatch({ mergeVertical: checked ? true : undefined })}
                  />
                }
                onChange={(value) => onPatch({ caption: value })}
              />
              {/* 表头与数据一起改：列数就是表头的格数，行数就是数据行数，两个都按网格写回 */}
              <TableGrid
                headers={headerCells(block)}
                data={dataRows(block)}
                onChange={(next) =>
                  onPatch({
                    headers: next.headers,
                    data: next.data,
                    cols: next.headers.length,
                    rows: next.data.length
                  })
                }
              />
            </>
          )}

          {type === 'code' && (
            <TextAreaField
              label="代码"
              tip={jsonTip('content')}
              mono
              rows={6}
              extra={
                <InlineSelect
                  label="代码语言"
                  tip={jsonTip(
                    'language',
                    `常用 ${CODE_LANGUAGES.map((code) => CODE_LANGUAGE_LABELS[code] ?? code).join('、')}`
                  )}
                  value={str(block['language'])}
                  options={[
                    ...CODE_LANGUAGES.map((code) => ({
                      value: code,
                      label: CODE_LANGUAGE_LABELS[code] ?? code
                    })),
                    // 模板里写的是别的语言名：留着它自己那一项，别让下拉把它顶掉
                    ...(str(block['language']) !== '' &&
                    !(CODE_LANGUAGES as readonly string[]).includes(str(block['language']))
                      ? [{ value: str(block['language']), label: str(block['language']) }]
                      : [])
                  ]}
                  onChange={(value) => onPatch({ language: value })}
                />
              }
              value={str(block['content'])}
              onChange={(value) => onPatch({ content: value })}
            />
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
            <div className="tpl-grid-2">
              <TextField
                label="图片路径"
                tip={jsonTip('content', '工程内相对路径')}
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
            </div>
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

        {typo !== null && (
          <p className="tpl-note tpl-note-bad">
            这份块里的「{typo.key}」与「{typo.known}」只差大小写，程序按没写处理（改过来才会生效）
          </p>
        )}

        <IssueLines issues={issues} />
      </div>
      )}
    </article>
  )
}

export default BlockForm
