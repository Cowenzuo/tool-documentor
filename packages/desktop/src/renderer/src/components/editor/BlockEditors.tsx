/**
 * 8 种内容块编辑器（受控组件：value 由父层 NodePage 提供，onChange 即时回传）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  clampRowSpans,
  resolveTableMerges,
  countVerticalMerges
} from '@documentor/core/table-merge'
import { TABLE_MAX_COLS, TABLE_MAX_ROWS } from '@documentor/core/table-limits'
import { normalizeMermaidSource } from '@documentor/core/mermaid-source'
import type {
  CodeBlock,
  ContentBlock,
  FormulaBlock,
  ImageBlock,
  ListBlock,
  MermaidBlock,
  TableBlock,
  TextBlock
} from '@documentor/core/blocks'
import { CODE_LANGUAGE_LABELS, CODE_LANGUAGES } from './blockTypes'
import { highlightCode } from '../../utils/highlight'
import {
  ensureMermaidEngine,
  renderMermaidSvg,
  writeMermaidPngCache
} from '../../utils/mermaid'
import 'katex/dist/katex.min.css'

export interface LightboxRequest {
  src: string
  title?: string
}

interface EditorBaseProps<T extends ContentBlock> {
  block: T
  onChange: (next: T) => void
  /** 图片块点击预览 */
  onPreview?: (req: LightboxRequest) => void
  /** 模板锁 `readonly`：内容由模板给定，编辑器只呈现不接收改动 */
  readOnly?: boolean
}

// ---------------- 文本 ----------------
export function TextEditor(props: EditorBaseProps<TextBlock>): React.JSX.Element {
  return (
    <textarea
      className="be-textarea"
      value={props.block.content}
      onChange={(e) => props.onChange({ ...props.block, content: e.target.value })}
      placeholder="输入文本内容…"
      readOnly={props.readOnly === true}
      rows={Math.min(24, Math.max(3, props.block.content.split('\n').length + 1))}
    />
  )
}

// ---------------- 图片 ----------------
export function ImageEditor(props: EditorBaseProps<ImageBlock>): React.JSX.Element {
  const { block, onChange, readOnly } = props
  const [thumb, setThumb] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const lockedHint = readOnly === true ? '模板规定该图片为定稿，不能更换' : undefined

  useEffect(() => {
    let disposed = false
    setThumb(null)
    if (block.imagePath) {
      void window.documentor.files.readAsDataUrl(block.imagePath).then((url) => {
        if (!disposed && url) setThumb(url)
      })
    }
    return () => {
      disposed = true
    }
  }, [block.imagePath])

  const importFromFile = (file: File | undefined | null): void => {
    if (!file || readOnly === true) return
    setBusy(true)
    const ext = file.name.includes('.') ? '.' + file.name.split('.').pop()!.toLowerCase() : '.png'
    const name = `${crypto.randomUUID()}${ext}`
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result === 'string') {
        const base64 = result.slice(result.indexOf(',') + 1)
        void window.documentor.block
          .writeBytes({ relPath: `images/${name}`, base64 })
          .then(() => {
            // 与写文件时的路径一致：读图的地方都按工程目录解析，写裸文件名会读不到
            onChange({ ...block, imagePath: `images/${name}` })
          })
          .catch((err: unknown) => {
            console.error('[image] write failed:', err)
          })
          .finally(() => setBusy(false))
      } else {
        setBusy(false)
      }
    }
    reader.onerror = () => setBusy(false)
    reader.readAsDataURL(file)
  }

  return (
    <div
      className={`be-image${thumb || block.imagePath ? '' : ' be-image-empty'}`}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        importFromFile(e.dataTransfer.files?.[0])
      }}
    >
      <div className="be-image-top">
        <input
          className="be-input be-image-caption"
          value={block.caption}
          onChange={(e) => onChange({ ...block, caption: e.target.value })}
          placeholder="图名（题注，将显示在图下方）"
          readOnly={readOnly === true}
        />
        <div className="be-image-actions">
          <button
            type="button"
            className="be-btn"
            onClick={() => fileRef.current?.click()}
            disabled={busy || readOnly === true}
            title={lockedHint}
          >
            {block.imagePath ? '更换图片' : '导入图片'}
          </button>
          {block.imagePath && (
            <button
              type="button"
              className="be-btn"
              onClick={() => onChange({ ...block, imagePath: '' })}
              disabled={readOnly === true}
              title={readOnly === true ? '模板规定该图片为定稿，不能移除' : undefined}
            >
              移除
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*,.emf"
            hidden
            onChange={(e) => {
              importFromFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
        </div>
      </div>
      {thumb ? (
        <button
          type="button"
          className="be-image-thumb"
          title="点击查看大图"
          onClick={() =>
            props.onPreview?.({ src: thumb, title: block.caption || block.imagePath })
          }
        >
          <img src={thumb} alt={block.caption || '图片'} />
        </button>
      ) : (
        <div className="be-image-placeholder">拖拽图片到此处，或点击「导入图片」</div>
      )}
    </div>
  )
}

// ---------------- 表格 ----------------
export function TableEditor(props: EditorBaseProps<TableBlock>): React.JSX.Element {
  const { block, onChange, readOnly } = props
  const gridRef = useRef<HTMLDivElement | null>(null)
  /** 整块只读：单元格呈现给定内容，尺寸与合并开关都不给入口 */
  const locked = readOnly === true
  /** 缩表会丢内容时，先挂起等用户确认（不做静默截断） */
  const [pendingShrink, setPendingShrink] = useState<{
    rows: number
    cols: number
    lostRows: number
    lostCols: number
    lostCells: number
  } | null>(null)

  // 显示真实规模：以前行数框显示 clamp 后的 50，而界面渲染 85 行，两处对不上。
  // 上限只用来提示"超出界面舒适区"，不再当作数据的截断依据。
  const realRows = block.data.length
  const realCols = Math.max(block.cols, ...block.data.map((r) => r.length), block.headers.length, 0)
  const overLimit = realRows > TABLE_MAX_ROWS || realCols > TABLE_MAX_COLS

  /** 缩减时会丢掉的非空单元格数（增量增长不算丢失） */
  const countLoss = (rows: number, cols: number): { rows: number; cols: number; cells: number } => {
    const lostRows = Math.max(0, block.data.length - rows)
    const rowLoss = block.data.slice(rows)
    const lostCellsInRows = rowLoss.flat().filter((v) => v.trim() !== '').length
    // 列方向的丢失：只在真正缩列时统计右侧非空单元格
    let lostCols = 0
    let lostCellsInCols = 0
    if (cols < realCols) {
      lostCols = realCols - cols
      for (const row of block.data) {
        lostCellsInCols += row.slice(cols).filter((v) => v.trim() !== '').length
      }
      if (block.headers.slice(cols).some((h) => h.trim() !== '')) lostCellsInCols += 1
    }
    return { rows: lostRows, cols: lostCols, cells: lostCellsInRows + lostCellsInCols }
  }

  /** 真正执行尺寸变更：只在这里改 data，且**只扩容不静默裁剪** */
  const applySize = (rows: number, cols: number): void => {
    const r = Math.max(0, rows)
    const c = Math.max(1, cols)
    // 扩容补空；缩容时保留原数据（由调用方确认后再调 applySize）
    const data = Array.from({ length: Math.max(r, block.data.length) }, (_, ri) => {
      const src = block.data[ri] ?? []
      const width = Math.max(c, src.length)
      return [...src.slice(0, c), ...Array.from({ length: Math.max(0, c - src.length) }, () => '')].slice(
        0,
        width
      )
    })
    // 确认缩容后才真正裁掉
    const trimmed = data.slice(0, r).map((row) => row.slice(0, c))
    const headers = [
      ...block.headers.slice(0, c),
      ...Array.from({ length: Math.max(0, c - block.headers.length) }, () => '')
    ]
    // 跨度按新尺寸重算：缩掉的行走列上的旧跨度若原样留着，
    // 导出与预览会照它去写合并，落到表外或与列错位。
    // 只动跨度、不动 data（值仍在原处）；没被改动就不写回，省一次入库与重渲染
    const clamped = clampRowSpans(block.rowSpans, trimmed.length, c)
    onChange({
      ...block,
      rows: trimmed.length,
      cols: c,
      headers,
      data: trimmed,
      rowSpans: clamped.changed ? clamped.spans : block.rowSpans
    })
  }

  const requestSize = (rows: number, cols: number): void => {
    const loss = countLoss(rows, cols)
    if (loss.cells > 0) {
      setPendingShrink({ rows, cols, lostRows: loss.rows, lostCols: loss.cols, lostCells: loss.cells })
      return
    }
    applySize(rows, cols)
  }

  const setCell = (r: number, c: number, value: string): void => {
    const data = block.data.map((row, ri) => (ri === r ? row.map((cell, ci) => (ci === c ? value : cell)) : row))
    onChange({ ...block, data })
  }

  const setHeader = (c: number, value: string): void => {
    const headers = block.headers.map((h, hi) => (hi === c ? value : h))
    onChange({ ...block, headers })
  }

  const moveFocus = (rowId: string): void => {
    gridRef.current?.querySelector<HTMLElement>(`[data-cell="${rowId}"]`)?.focus()
  }

  // 合并来源：显式跨度逐格优先，老数据退回兼容判定（与导出/预览同一个函数）。
  // 列数按表头、cols 与数据行的最大值取，导出侧就是这个口径
  const merges = resolveTableMerges({
    data: block.data,
    headers: block.headers,
    cols: block.cols,
    rowSpans: block.rowSpans,
    mergeVertical: block.mergeVertical
  })
  const mergeCount = countVerticalMerges(merges)

  return (
    <div className="be-table">
      <div className="be-table-top">
        <input
          className="be-input be-table-caption"
          value={block.caption}
          onChange={(e) => onChange({ ...block, caption: e.target.value })}
          placeholder="表名（题注，将显示在表上方）"
          readOnly={locked}
        />
        <div className="be-table-size">
          <label>
            行
            <input
              type="number"
              min={0}
              value={realRows}
              onChange={(e) => requestSize(Number(e.target.value) || 0, realCols)}
              disabled={locked}
              title={locked ? '模板规定该表格为定稿，行数不能改' : undefined}
            />
          </label>
          <label>
            列
            <input
              type="number"
              min={1}
              value={realCols}
              onChange={(e) => requestSize(realRows, Number(e.target.value) || 1)}
              disabled={locked}
              title={locked ? '模板规定该表格为定稿，列数不能改' : undefined}
            />
          </label>
        </div>
      </div>

      {/* 超出界面舒适区只提示，不裁剪数据：表照常保存与导出 */}
      {overLimit && (
        <p className="be-table-warn">
          本表 {realRows} 行 × {realCols} 列，超出界面一次编辑的舒适规模（
          {TABLE_MAX_ROWS} 行 × {TABLE_MAX_COLS} 列）。数据完整保留，导出不受影响；
          建议分批编辑或拆表。
        </p>
      )}

      {/* 缩表会丢内容：先确认，不静默截断 */}
      {pendingShrink && (
        <div className="be-table-confirm" role="alertdialog" aria-label="确认缩减表格">
          <div>
            这次缩减会丢失
            {pendingShrink.lostRows > 0 ? ` ${pendingShrink.lostRows} 行` : ''}
            {pendingShrink.lostCols > 0 ? ` ${pendingShrink.lostCols} 列` : ''}
            {`（共 ${pendingShrink.lostCells} 个非空单元格）`}，无法撤销。
          </div>
          <div className="be-table-confirm-actions">
            <button
              type="button"
              className="be-btn danger-text"
              onClick={() => {
                applySize(pendingShrink.rows, pendingShrink.cols)
                setPendingShrink(null)
              }}
            >
              确认缩减为 {pendingShrink.rows} 行 × {pendingShrink.cols} 列
            </button>
            <button type="button" className="be-btn" onClick={() => setPendingShrink(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      <div className="be-table-merge-bar">
        <label
          className="be-table-merge"
          title="同列相邻同值合并"
        >
          <input
            type="checkbox"
            checked={block.mergeVertical === true}
            disabled={locked}
            onChange={(e) =>
              onChange(
                e.target.checked
                  ? { ...block, mergeVertical: true }
                  : { ...block, mergeVertical: undefined }
              )
            }
          />
          相同内容自动合并（纵向）
          {block.mergeVertical === true && (
            <span className="be-table-merge-hint">
              {mergeCount > 0 ? `已合并 ${mergeCount} 处` : '当前没有可合并的相邻单元格'}
            </span>
          )}
        </label>
      </div>

      <div className="be-table-grid" ref={gridRef}>
        <div className="be-table-row be-table-head">
          <div className="be-table-corner" />
          {Array.from({ length: realCols }, (_, c) => (
            <input
              key={`h${c}`}
              data-cell={`h${c}`}
              className="be-table-header"
              value={block.headers[c] ?? ''}
              placeholder={`列${c + 1}`}
              readOnly={locked}
              onChange={(e) => setHeader(c, e.target.value)}
              onKeyDown={(e) => {
                const next =
                  e.key === 'Tab'
                    ? c + 1 < realCols
                      ? `h${c + 1}`
                      : `0:0`
                    : e.key === 'ArrowRight' && c + 1 < realCols
                      ? `h${c + 1}`
                      : e.key === 'ArrowDown' && realRows > 0
                        ? `0:${c}`
                        : null
                if (next) {
                  e.preventDefault()
                  moveFocus(next)
                }
              }}
            />
          ))}
        </div>
        {Array.from({ length: realRows }, (_, r) => (
          <div className="be-table-row" key={r}>
            <div className="be-table-corner">{r + 1}</div>
            {Array.from({ length: realCols }, (_, c) => (
              <input
                key={`${r}:${c}`}
                data-cell={`${r}:${c}`}
                className={
                  merges?.[r]?.[c]?.covered === true
                    ? 'be-table-cell be-table-cell-merged'
                    : 'be-table-cell'
                }
                title={merges?.[r]?.[c]?.covered === true ? '与上方相同，预览/导出时合并' : undefined}
                value={block.data[r]?.[c] ?? ''}
                readOnly={locked}
                onChange={(e) => setCell(r, c, e.target.value)}
                onKeyDown={(e) => {
                  let next: string | null = null
                  if (e.key === 'Tab') {
                    next = c + 1 < realCols ? `${r}:${c + 1}` : r + 1 < realRows ? `${r + 1}:0` : null
                  } else if (e.key === 'ArrowRight' && c + 1 < realCols) {
                    next = `${r}:${c + 1}`
                  } else if (e.key === 'ArrowLeft' && c > 0) {
                    next = `${r}:${c - 1}`
                  } else if (e.key === 'ArrowUp' && r > 0) {
                    next = `${r - 1}:${c}`
                  } else if (e.key === 'ArrowDown' && r + 1 < realRows) {
                    next = `${r + 1}:${c}`
                  }
                  if (next) {
                    e.preventDefault()
                    moveFocus(next)
                  }
                }}
              />
            ))}
          </div>
        ))}
        {realRows === 0 && <div className="be-table-empty-row">（无数据行）</div>}
      </div>
    </div>
  )
}

// ---------------- 公式（源码编辑 + 即时预览） ----------------
export function FormulaEditor(props: EditorBaseProps<FormulaBlock>): React.JSX.Element {
  const [view, setView] = useState<'edit' | 'preview'>('edit')
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    window.clearTimeout(timerRef.current)
    if (view !== 'preview' || !props.block.latexCode.trim()) {
      setHtml(null)
      setError(null)
      return
    }
    timerRef.current = window.setTimeout(async () => {
      try {
        const katex = (await import('katex')).default
        setHtml(
          katex.renderToString(props.block.latexCode, {
            throwOnError: false,
            displayMode: true
          })
        )
        setError(null)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setHtml(null)
      }
    }, 500)
    return () => window.clearTimeout(timerRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.block.latexCode, view])

  return (
    <div className="be-formula">
      <div className="be-view-toggle">
        <button
          type="button"
          className={view === 'edit' ? 'active' : ''}
          onClick={() => setView('edit')}
        >
          编辑
        </button>
        <button
          type="button"
          className={view === 'preview' ? 'active' : ''}
          onClick={() => setView('preview')}
        >
          预览
        </button>
      </div>
      {view === 'edit' ? (
        <textarea
          className="be-textarea be-mono"
          value={props.block.latexCode}
          onChange={(e) => props.onChange({ ...props.block, latexCode: e.target.value })}
          placeholder="公式源码，如 E = mc^2"
          spellCheck={false}
          readOnly={props.readOnly === true}
        />
      ) : (
        <div className="be-formula-preview">
          {!html && !error && (
            <div className="be-mermaid-hint">
              {props.block.latexCode.trim() ? '渲染中…' : '输入公式源码预览'}
            </div>
          )}
          {error && <div className="be-mermaid-error">渲染失败：{error}</div>}
          {html && <div dangerouslySetInnerHTML={{ __html: html }} />}
        </div>
      )}
    </div>
  )
}

// ---------------- 代码（语言下拉 + 编辑/语法高亮浏览切换） ----------------
export function CodeEditor(props: EditorBaseProps<CodeBlock>): React.JSX.Element {
  const { block, onChange, readOnly } = props
  const [view, setView] = useState<'edit' | 'highlight'>('edit')
  const language = (CODE_LANGUAGES as readonly string[]).includes(block.language)
    ? block.language
    : 'plain'
  const html = useMemo(() => highlightCode(block.code, language), [block.code, language])

  return (
    <div className="be-code">
      <div className="be-code-tools">
        {/*
          语言选择不算"块类型"：只锁类型时照常可改；整块只读时语言也是模板定的那一份，
          一并关掉。
        */}
        <select
          className="be-select"
          value={language}
          onChange={(e) => onChange({ ...block, language: e.target.value })}
          aria-label="代码语言"
          disabled={readOnly === true}
          title={readOnly === true ? '模板定稿' : undefined}
        >
          {CODE_LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>
              {CODE_LANGUAGE_LABELS[lang]}
            </option>
          ))}
        </select>
        <div className="be-view-toggle">
          <button
            type="button"
            className={view === 'edit' ? 'active' : ''}
            onClick={() => setView('edit')}
          >
            编辑
          </button>
          <button
            type="button"
            className={view === 'highlight' ? 'active' : ''}
            onClick={() => setView('highlight')}
            title="语法高亮浏览"
          >
            高亮
          </button>
        </div>
      </div>
      {view === 'edit' ? (
        <textarea
          className="be-textarea be-mono be-code-area"
          value={block.code}
          onChange={(e) => onChange({ ...block, code: e.target.value })}
          placeholder="输入代码…"
          spellCheck={false}
          readOnly={readOnly === true}
          rows={Math.min(30, Math.max(5, block.code.split('\n').length + 1))}
        />
      ) : (
        <pre className="code-highlight-view" tabIndex={0} aria-label="代码高亮浏览（只读）">
          <code
            className={`language-${language}`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </pre>
      )}
    </div>
  )
}

// ---------------- Mermaid（左源码右预览分栏） ----------------
export function MermaidEditor(props: EditorBaseProps<MermaidBlock>): React.JSX.Element {
  const { block, onChange, readOnly } = props
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState<boolean>(false)
  const timerRef = useRef<number | undefined>(undefined)
  const locked = readOnly === true

  useEffect(() => {
    let disposed = false
    void ensureMermaidEngine()
      .then(() => {
        if (!disposed) setReady(true)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [])

  useEffect(() => {
    window.clearTimeout(timerRef.current)
    if (!ready || !block.code.trim()) {
      setPreview(null)
      setError(null)
      return
    }
    timerRef.current = window.setTimeout(async () => {
      try {
        const svg = await renderMermaidSvg(block.code)
        setPreview(svg)
        setError(null)
        void writeMermaidPngCache(svg, block.code)
      } catch (err) {
        setPreview(null)
        setError(err instanceof Error ? err.message : String(err))
      }
    }, 700)
    return () => window.clearTimeout(timerRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.code, ready])

  return (
    <div className="be-mermaid">
      <div className="be-mermaid-caption">
        <input
          className="be-input"
          value={block.caption}
          onChange={(e) => onChange({ ...block, caption: e.target.value })}
          placeholder="图名（题注，将显示在图下方）"
          readOnly={locked}
        />
      </div>
      <div className="be-mermaid-split">
        <textarea
          className="be-textarea be-mono"
          value={block.code}
          onChange={(e) => onChange({ ...block, code: e.target.value })}
          onBlur={() => {
            // 失焦时把源码规整一次并落库：粘进来的围栏与 `mermaid` 语言标签留在这里
            // 会让渲染报 "No diagram type detected"，导出侧也吃同一份源码。
            // 只清"包裹"，不碰图定义本身。整块只读时连规整也不写，免得动了模板给定的定稿。
            if (locked) return
            const cleaned = normalizeMermaidSource(block.code)
            if (cleaned !== block.code) onChange({ ...block, code: cleaned })
          }}
          placeholder={'graph TD\n  A[开始] --> B[结束]'}
          spellCheck={false}
          readOnly={locked}
        />
        <div className="be-mermaid-preview">
          {!ready && <div className="be-mermaid-hint">加载渲染引擎…</div>}
          {ready && !preview && !error && (
            <div className="be-mermaid-hint">{block.code.trim() ? '渲染中…' : '输入流程图源码预览'}</div>
          )}
          {error && <div className="be-mermaid-error">渲染失败：{error}</div>}
          {preview && (
            <button
              type="button"
              className="be-mermaid-svg-wrap"
              onClick={() =>
                preview &&
                props.onPreview?.({
                  src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(preview)}`,
                  title: block.caption || '流程图'
                })
              }
            >
              <div dangerouslySetInnerHTML={{ __html: preview }} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------- 列表 ----------------
export function ListEditor(
  props: EditorBaseProps<ListBlock> & { ordered: boolean }
): React.JSX.Element {
  const { block, onChange } = props
  const text = block.items.join('\n')
  const handle = (value: string): void => {
    // 对齐旧版语义：按行拆分（空行过滤，同 C++ SkipEmptyParts）
    const items = value.split('\n').filter((line) => line.trim().length > 0)
    onChange({ ...block, items })
  }
  return (
    <textarea
      className="be-textarea be-list-area"
      value={text}
      onChange={(e) => handle(e.target.value)}
      placeholder={props.ordered ? '每行一个条目（自动编号）' : '每行一个条目'}
      readOnly={props.readOnly === true}
      rows={Math.min(20, Math.max(2, text.split('\n').length + 1))}
    />
  )
}
