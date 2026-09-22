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
import { BLOCK_TIER, blockTierOf } from '../../../../shared/permissionTerms'
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
  rawBlockLock,
  str,
  typoField,
  BLOCK_FIELDS,
  type TemplateObject
} from './templateDoc'

const LOCK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: BLOCK_TIER.free.name },
  { value: 'keep', label: BLOCK_TIER.keep.name },
  { value: 'readonly', label: BLOCK_TIER.readonly.name }
]

/**
 * 档位在模板使用者那一侧意味着什么，一句话（词表在 shared/permissionTerms，与工程编辑器同一份）。
 * 位置（顺序）不在档位里：那由节点级的「排版」管，所以这里只说内容、类型与存在。
 * 旧档位那一句带作者侧的动作建议，只在这一侧说。
 */
function lockHint(lock: string): string {
  if (lock === 'type') return `${BLOCK_TIER.legacy.name}：${BLOCK_TIER.legacy.tip} · 建议改成${BLOCK_TIER.keep.name}`
  return blockTierOf(lock).tip
}

function lockTag(lock: string): string | null {
  return blockTierOf(lock).tag
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
  onPatch: (patch: TemplateObject) => void
  onMove: (delta: -1 | 1) => void
  onRemove: () => void
  /** 选一张本机图片（对话框在主进程），回来把路径填进字段 */
  onPickImage: () => Promise<string | null>
  /** 右键卡片：上方插入 / 下方插入 / 复制这一块（挪与删是卡片上的按钮，菜单里不重复） */
  onOpenMenu: (x: number, y: number) => void
}

export function BlockForm(props: BlockFormProps): JSX.Element {
  const { block, index, count, open, onToggle, issues, onPatch, onMove, onRemove, onOpenMenu, onPickImage } =
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
   * 作者的挪与删一律放行：锁是给模板使用者设的，位置那一维由节点级的「排版」管。
   * 卡片上只用锁标记与提示交代这一档在用户侧意味着什么。
   */
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
            {/* 旧档位 type：类型固定但可删。新口径没有这一档，就地给一个改过去的动作 */}
            {lock === 'type' && (
              <button
                type="button"
                className="tpl-mini"
                title="旧档位 type · 改成类型限制编辑（类型固定且不可删）"
                onClick={() => onPatch({ lock: 'keep' })}
              >
                改成类型限制编辑
              </button>
            )}
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
            aria-label="上移这一块"
            onClick={() => onMove(-1)}
            disabled={index === 0}
          >
            <MoveUpIcon />
          </button>
          <button
            type="button"
            className="tpl-icon-btn"
            aria-label="下移这一块"
            onClick={() => onMove(1)}
            disabled={index === count - 1}
          >
            <MoveDownIcon />
          </button>
          <button
            type="button"
            className="tpl-icon-btn tpl-danger"
            aria-label="删除这一块"
            onClick={onRemove}
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
            <>
              {/* 题注在前、内容在后：与流程图（图题 + 源码）和表格（表名 + 网格）同一个次序 */}
              <TextField
                label="图题"
                tip={jsonTip('caption')}
                value={str(block['caption'])}
                onChange={(value) => onPatch({ caption: value })}
              />
              {/* 路径旁边就是选图片的按钮：本机挑一张，路径直接填进来，不用手抄 */}
              <div className="tpl-row">
                <TextField
                  label="图片路径"
                  tip={jsonTip('content', '工程内相对路径')}
                  mono
                  hint="可留空"
                  value={str(block['content'])}
                  onChange={(value) => onPatch({ content: value })}
                />
                <button
                  type="button"
                  className="tpl-mini"
                  title="从本机选一张图片，路径填进这个字段"
                  onClick={() => {
                    void onPickImage().then((picked) => {
                      if (picked !== null && picked !== '') onPatch({ content: picked })
                    })
                  }}
                >
                  选图片…
                </button>
              </div>
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
