/**
 * 表格块的网格：表头一行 + 数据若干行，格子里直接写。
 *
 * 为什么不用「用 | 分隔的文本」：表格是二维的东西，写成文本之后列数、缺格、多格全靠数与对，
 * 改一列要在每一行上同步改；网格里点哪格写哪格，增删行列就是增删行列。
 *
 * 列数不单独填：校验里 `headers` 的格数必须等于 `cols`，所以列数就是表头的格数。
 * 数据行比表头宽时，多出来的格子照样显示并标出来——作者写的内容不许被悄悄删掉；
 * 要清掉就在那一列上右键删掉它。
 *
 * 纵向合并不在这里管：合并是编辑那边的事，模板里把重复的值写出来就行。
 */
import { type JSX } from 'react'
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu'
import { TrashIcon } from './icons'

export interface TableGridProps {
  headers: string[]
  data: string[][]
  /** 改网格：表头与数据一起回去（列数、行数由调用方按这两样写回 JSON） */
  onChange: (next: { headers: string[]; data: string[][] }) => void
}

/** 表格里的一格：多出来的列标出来，短行也标出来，免得"看着对、校验报错" */
interface GridShape {
  /** 网格画几列 */
  cols: number
  /** 数据行比表头宽出几列 */
  extraCols: number
}

function shapeOf(headers: string[], data: string[][]): GridShape {
  const widest = data.reduce((max, row) => Math.max(max, row.length), 0)
  const cols = Math.max(headers.length, widest)
  return { cols, extraCols: Math.max(0, widest - headers.length) }
}

export function TableGrid({ headers, data, onChange }: TableGridProps): JSX.Element {
  const { cols, extraCols } = shapeOf(headers, data)
  const menu = useContextMenu<{ kind: 'col' | 'row'; index: number }>()
  /** 右键开在哪一格上：表头格是"这一列"，数据格是"这一行" */

  // 一列都没有（表头与数据都空）时也要有列宽，否则网格模板是非法值
  const gridTemplate = `repeat(${Math.max(1, cols)}, minmax(72px, 1fr)) 26px`

  const writeCell = (rowIndex: number, colIndex: number, value: string): void => {
    const next = data.map((row, r) => {
      if (r !== rowIndex) return row
      const cells = [...row]
      while (cells.length <= colIndex) cells.push('')
      cells[colIndex] = value
      return cells
    })
    onChange({ headers, data: next })
  }

  const writeHeader = (colIndex: number, value: string): void => {
    const next = [...headers]
    while (next.length <= colIndex) next.push('')
    next[colIndex] = value
    onChange({ headers: next, data })
  }

  /** 整行补齐到表头格数：增删列是作者点的动作，补齐是这一步的一部分 */
  const padTo = (row: string[], width: number): string[] => {
    const next = [...row]
    while (next.length < width) next.push('')
    return next
  }

  const addRow = (at: number): void => {
    const blank = Array<string>(headers.length).fill('')
    const next = [...data]
    const index = at < 0 || at > next.length ? next.length : at
    next.splice(index, 0, blank)
    onChange({ headers, data: next })
  }

  const removeRow = (index: number): void => {
    onChange({ headers, data: data.filter((_, r) => r !== index) })
  }

  const addColumn = (at: number): void => {
    const nextHeaders = [...headers]
    const index = at < 0 || at > nextHeaders.length ? nextHeaders.length : at
    nextHeaders.splice(index, 0, '')
    const nextData = data.map((row) => {
      const cells = padTo(row, Math.max(headers.length, row.length))
      cells.splice(index, 0, '')
      return cells
    })
    onChange({ headers: nextHeaders, data: nextData })
  }

  const removeColumn = (index: number): void => {
    onChange({
      headers: headers.filter((_, c) => c !== index),
      data: data.map((row) => row.filter((_, c) => c !== index))
    })
  }

  const menuItems: MenuItem[] =
    menu.payload === null
      ? []
      : menu.payload.kind === 'col'
        ? [
            { label: '在左边插一列', run: () => addColumn(menu.payload!.index) },
            { label: '在右边插一列', run: () => addColumn(menu.payload!.index + 1) },
            {
              label: '删除这一列',
              danger: true,
              title: '整列从表头与每一行里去掉',
              run: () => removeColumn(menu.payload!.index)
            }
          ]
        : [
            { label: '在上面插一行', run: () => addRow(menu.payload!.index) },
            { label: '在下面插一行', run: () => addRow(menu.payload!.index + 1) },
            {
              label: '删除这一行',
              danger: true,
              run: () => removeRow(menu.payload!.index)
            }
          ]

  return (
    <div className="tpl-tg">
      <div className="tpl-tg-scroll">
        <div className="tpl-tg-grid" style={{ gridTemplateColumns: gridTemplate }}>
          {/* 表头：一格一列，右端那个窄格是"加一列" */}
          {headers.map((cell, c) => (
            <input
              key={`h${c}`}
              className="tpl-tg-cell is-head"
              value={cell}
              placeholder={`表头 ${c + 1}`}
              aria-label={`表头第 ${c + 1} 列`}
              title={`字段 headers[${c}]`}
              onChange={(event) => writeHeader(c, event.target.value)}
              onContextMenu={(event) => {
                event.preventDefault()
                menu.openIn({ kind: 'col', index: c }, event.clientX, event.clientY)
              }}
            />
          ))}
          {Array.from({ length: extraCols }, (_, c) => (
            <span
              key={`x${c}`}
              className="tpl-tg-cell is-extra"
              title="表头没有这一列 · 校验会报，右键可以删掉它"
            >
              多 {headers.length + c + 1}
            </span>
          ))}
          <button
            type="button"
            className="tpl-tg-add"
            title="在表头末尾加一列"
            aria-label="加一列"
            onClick={() => addColumn(-1)}
          >
            ＋
          </button>

          {/* 数据行：每行右端那个窄格是"删这一行" */}
          {data.map((row, r) => (
            <RowCells
              key={`r${r}`}
              row={row}
              rowIndex={r}
              cols={cols}
              headCount={headers.length}
              onCell={writeCell}
              onRemove={() => removeRow(r)}
              onMenu={(x, y) => menu.openIn({ kind: 'row', index: r }, x, y)}
            />
          ))}
        </div>
      </div>

      <div className="tpl-tg-foot">
        <button
          type="button"
          className="tpl-mini tpl-inline-action"
          title="在末尾加一行数据"
          onClick={() => addRow(-1)}
        >
          ＋ 一行
        </button>
        <span className="tpl-count">
          {headers.length} 列{data.length === 0 ? ' · 没有数据行' : ''}
        </span>
      </div>

      {menu.payload && (
        <ContextMenu
          control={menu}
          className="tpl-block-menu"
          label="表格操作"
          head={menu.payload.kind === 'col' ? `第 ${menu.payload.index + 1} 列` : `第 ${menu.payload.index + 1} 行`}
          items={menuItems}
        />
      )}
    </div>
  )
}

/** 一行的格子：与表头同一套列宽，右端是删这一行 */
function RowCells({
  row,
  rowIndex,
  cols,
  headCount,
  onCell,
  onRemove,
  onMenu
}: {
  row: string[]
  rowIndex: number
  cols: number
  headCount: number
  onCell: (rowIndex: number, colIndex: number, value: string) => void
  onRemove: () => void
  onMenu: (x: number, y: number) => void
}): JSX.Element {
  const short = row.length < headCount
  return (
    <>
      {Array.from({ length: cols }, (_, c) => (
        <input
          key={`c${c}`}
          className={`tpl-tg-cell${c >= headCount ? ' is-extra' : ''}`}
          value={row[c] ?? ''}
          aria-label={`第 ${rowIndex + 1} 行第 ${c + 1} 列`}
          title={
            short
              ? `这行 ${row.length} 格 · 表头 ${headCount} 格`
              : c >= headCount
                ? '表头没有这一列 · 校验会报，右键可以删掉它'
                : undefined
          }
          onChange={(event) => onCell(rowIndex, c, event.target.value)}
          onContextMenu={(event) => {
            event.preventDefault()
            onMenu(event.clientX, event.clientY)
          }}
        />
      ))}
      <button
        type="button"
        className="tpl-tg-del"
        title="删除这一行"
        aria-label={`删除第 ${rowIndex + 1} 行`}
        onClick={onRemove}
      >
        <TrashIcon size={13} />
      </button>
    </>
  )
}

export default TableGrid
