/**
 * 列表块的条目：一条一行，行里直接写，行上有换位与删除。
 *
 * 为什么不用「一行一条的文本域」：条目的顺序就是列表的语义，换位在文本域里只能剪切粘贴；
 * 也看不出几条、哪条空了。这里一条一个输入框，标记列按有序无序给（1. / •），
 * 与导出后的样子对得上；换位是行上的动作，增删行上是按钮、中间插走在右键菜单里（与表格网格同一套）。
 */
import { type JSX } from 'react'
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu'
import { MoveDownIcon, MoveUpIcon, TrashIcon } from './icons'

export interface ListRowsProps {
  items: string[]
  /** 有序列表标 1. 2. 3.，无序列表标 •：导出那边就是这么编的号 */
  ordered: boolean
  onChange: (items: string[]) => void
}

export function ListRows({ items, ordered, onChange }: ListRowsProps): JSX.Element {
  const menu = useContextMenu<{ index: number }>()

  const writeItem = (index: number, value: string): void => {
    onChange(items.map((item, i) => (i === index ? value : item)))
  }

  const addItem = (at: number): void => {
    const next = [...items]
    const index = at < 0 || at > next.length ? next.length : at
    next.splice(index, 0, '')
    onChange(next)
  }

  const removeItem = (index: number): void => {
    onChange(items.filter((_, i) => i !== index))
  }

  const moveItem = (index: number, delta: -1 | 1): void => {
    const target = index + delta
    if (target < 0 || target >= items.length) return
    const next = [...items]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved ?? '')
    onChange(next)
  }

  const menuItems: MenuItem[] =
    menu.payload === null
      ? []
      : [
          { label: '在上面插一条', run: () => addItem(menu.payload!.index) },
          { label: '在下面插一条', run: () => addItem(menu.payload!.index + 1) },
          {
            label: '上移一条',
            disabled: menu.payload.index === 0,
            run: () => moveItem(menu.payload!.index, -1)
          },
          {
            label: '下移一条',
            disabled: menu.payload.index === items.length - 1,
            run: () => moveItem(menu.payload!.index, 1)
          },
          { label: '删除这一条', danger: true, run: () => removeItem(menu.payload!.index) }
        ]

  return (
    <div className="tpl-list-rows">
      <div className="tpl-field-label" title="字段 items">
        列表项
        <span className="tpl-field-hint">一条一行</span>
      </div>
      {items.map((item, index) => (
        <div className="tpl-list-row" key={index}>
          <span className="tpl-list-mark" aria-hidden="true">
            {ordered ? `${index + 1}.` : '•'}
          </span>
          <input
            className="tpl-tg-cell"
            value={item}
            placeholder={`第 ${index + 1} 条`}
            aria-label={`第 ${index + 1} 条`}
            onChange={(event) => writeItem(index, event.target.value)}
            onContextMenu={(event) => {
              event.preventDefault()
              menu.openIn({ index }, event.clientX, event.clientY)
            }}
          />
          {/* 换位贴在这一行上：指针进来或键盘落到这一行才显形，平时不占眼睛 */}
          <span className="tpl-list-move">
            <button
              type="button"
              className="tpl-icon-btn"
              title="上移一条"
              aria-label={`第 ${index + 1} 条上移`}
              disabled={index === 0}
              onClick={() => moveItem(index, -1)}
            >
              <MoveUpIcon size={12} />
            </button>
            <button
              type="button"
              className="tpl-icon-btn"
              title="下移一条"
              aria-label={`第 ${index + 1} 条下移`}
              disabled={index === items.length - 1}
              onClick={() => moveItem(index, 1)}
            >
              <MoveDownIcon size={12} />
            </button>
          </span>
          <button
            type="button"
            className="tpl-icon-btn tpl-danger"
            title="删除这一条"
            aria-label={`删除第 ${index + 1} 条`}
            onClick={() => removeItem(index)}
          >
            <TrashIcon size={13} />
          </button>
        </div>
      ))}

      <div className="tpl-list-foot">
        <button
          type="button"
          className="tpl-mini tpl-inline-action"
          title="在末尾加一条"
          onClick={() => addItem(-1)}
        >
          ＋ 一条
        </button>
      </div>

      {menu.payload && (
        <ContextMenu
          control={menu}
          className="tpl-block-menu"
          label="列表操作"
          head={`第 ${menu.payload.index + 1} 条`}
          items={menuItems}
        />
      )}
    </div>
  )
}

export default ListRows
