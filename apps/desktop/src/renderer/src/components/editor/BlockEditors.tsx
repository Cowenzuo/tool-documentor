/**
 * 8 种内容块编辑器（受控组件：value 由父层 NodePage 提供，onChange 即时回传）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
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
import {
  CODE_LANGUAGE_LABELS,
  CODE_LANGUAGES,
  TABLE_MAX_COLS,
  TABLE_MAX_ROWS
} from './blockTypes'
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
}

// ---------------- 文本 ----------------
export function TextEditor(props: EditorBaseProps<TextBlock>): React.JSX.Element {
  return (
    <textarea
      className="be-textarea"
      value={props.block.content}
      onChange={(e) => props.onChange({ ...props.block, content: e.target.value })}
      placeholder="输入文本内容…"
      rows={Math.min(24, Math.max(3, props.block.content.split('\n').length + 1))}
    />
  )
}

// ---------------- 图片 ----------------
export function ImageEditor(props: EditorBaseProps<ImageBlock>): React.JSX.Element {
  const { block, onChange } = props
  const [thumb, setThumb] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

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
    if (!file) return
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
            onChange({ ...block, imagePath: name })
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
        />
        <div className="be-image-actions">
          <button
            type="button"
            className="be-btn"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
          >
            {block.imagePath ? '更换图片' : '导入图片'}
          </button>
          {block.imagePath && (
            <button type="button" className="be-btn" onClick={() => onChange({ ...block, imagePath: '' })}>
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
          title="点击全屏预览"
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
  const { block, onChange } = props
  const gridRef = useRef<HTMLDivElement | null>(null)

  const clampRows = Math.min(TABLE_MAX_ROWS, Math.max(0, block.rows))
  const clampCols = Math.min(TABLE_MAX_COLS, Math.max(0, block.cols))

  const setSize = (rows: number, cols: number): void => {
    const r = Math.min(TABLE_MAX_ROWS, Math.max(0, rows))
    const c = Math.min(TABLE_MAX_COLS, Math.max(0, cols))
    const headers = [...block.headers.slice(0, c), ...Array.from({ length: Math.max(0, c - block.headers.length) }, () => '')]
    const data = Array.from({ length: r }, (_, ri) => {
      const src = block.data[ri] ?? []
      return [...src.slice(0, c), ...Array.from({ length: Math.max(0, c - src.length) }, () => '')]
    })
    onChange({ ...block, rows: r, cols: c, headers, data })
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

  return (
    <div className="be-table">
      <div className="be-table-top">
        <input
          className="be-input be-table-caption"
          value={block.caption}
          onChange={(e) => onChange({ ...block, caption: e.target.value })}
          placeholder="表名（题注，将显示在表上方）"
        />
        <div className="be-table-size">
          <label>
            行
            <input
              type="number"
              min={0}
              max={TABLE_MAX_ROWS}
              value={clampRows}
              onChange={(e) => setSize(Number(e.target.value) || 0, clampCols)}
            />
          </label>
          <label>
            列
            <input
              type="number"
              min={0}
              max={TABLE_MAX_COLS}
              value={clampCols}
              onChange={(e) => setSize(clampRows, Number(e.target.value) || 0)}
            />
          </label>
        </div>
      </div>

      <div className="be-table-grid" ref={gridRef}>
        <div className="be-table-row be-table-head">
          <div className="be-table-corner" />
          {Array.from({ length: clampCols }, (_, c) => (
            <input
              key={`h${c}`}
              data-cell={`h${c}`}
              className="be-table-header"
              value={block.headers[c] ?? ''}
              placeholder={`列${c + 1}`}
              onChange={(e) => setHeader(c, e.target.value)}
              onKeyDown={(e) => {
                const next =
                  e.key === 'Tab'
                    ? c + 1 < clampCols
                      ? `h${c + 1}`
                      : `0:0`
                    : e.key === 'ArrowRight' && c + 1 < clampCols
                      ? `h${c + 1}`
                      : e.key === 'ArrowDown' && clampRows > 0
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
        {Array.from({ length: clampRows }, (_, r) => (
          <div className="be-table-row" key={r}>
            <div className="be-table-corner">{r + 1}</div>
            {Array.from({ length: clampCols }, (_, c) => (
              <input
                key={`${r}:${c}`}
                data-cell={`${r}:${c}`}
                className="be-table-cell"
                value={block.data[r]?.[c] ?? ''}
                onChange={(e) => setCell(r, c, e.target.value)}
                onKeyDown={(e) => {
                  let next: string | null = null
                  if (e.key === 'Tab') {
                    next = c + 1 < clampCols ? `${r}:${c + 1}` : r + 1 < clampRows ? `${r + 1}:0` : null
                  } else if (e.key === 'ArrowRight' && c + 1 < clampCols) {
                    next = `${r}:${c + 1}`
                  } else if (e.key === 'ArrowLeft' && c > 0) {
                    next = `${r}:${c - 1}`
                  } else if (e.key === 'ArrowUp' && r > 0) {
                    next = `${r - 1}:${c}`
                  } else if (e.key === 'ArrowDown' && r + 1 < clampRows) {
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
        {clampRows === 0 && <div className="be-table-empty-row">（无数据行）</div>}
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
  const { block, onChange } = props
  const [view, setView] = useState<'edit' | 'highlight'>('edit')
  const language = (CODE_LANGUAGES as readonly string[]).includes(block.language)
    ? block.language
    : 'plain'
  const html = useMemo(() => highlightCode(block.code, language), [block.code, language])

  return (
    <div className="be-code">
      <div className="be-code-tools">
        <select
          className="be-select"
          value={language}
          onChange={(e) => onChange({ ...block, language: e.target.value })}
          aria-label="代码语言"
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
  const { block, onChange } = props
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState<boolean>(false)
  const timerRef = useRef<number | undefined>(undefined)

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
        />
      </div>
      <div className="be-mermaid-split">
        <textarea
          className="be-textarea be-mono"
          value={block.code}
          onChange={(e) => onChange({ ...block, code: e.target.value })}
          placeholder={'graph TD\n  A[开始] --> B[结束]'}
          spellCheck={false}
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
      rows={Math.min(20, Math.max(2, text.split('\n').length + 1))}
    />
  )
}
