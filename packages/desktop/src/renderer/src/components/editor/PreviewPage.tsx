/**
 * 静态预览（M6）：以文档排版感渲染当前选中节点（标题 + 内容块），所见接近导出正文。
 * 排版规则对齐导出：表题注在上、图题注在下且居中；代码/公式高亮渲染。
 */
import { useEffect, useState } from 'react'
import { resolveTableMerges } from '@documentor/core/table-merge'
import type { ContentBlock } from '@documentor/core/blocks'
import { useSelectedNode } from '../../state/AppContext'
import { renderMermaidSvg } from '../../utils/mermaid'
import { highlightCode } from '../../utils/highlight'
import { Lightbox } from '../Lightbox'
import { CODE_LANGUAGE_LABELS } from './blockTypes'

export function PreviewPage(): React.JSX.Element {
  const node = useSelectedNode()
  const [lightbox, setLightbox] = useState<string | null>(null)

  useEffect(() => {
    setLightbox(null)
  }, [node?.id])

  if (!node) {
    return (
      <main className="node-page node-page-empty">
        <div className="np-hint">从左侧结构树选择章节查看排版</div>
      </main>
    )
  }

  const headingClass =
    node.headingLevel === 0
      ? 'pv-h1'
      : `pv-h${Math.min(6, Math.max(1, node.headingLevel))}`

  return (
    <main className="node-page">
      <div className="pv-scroll">
        <article className="pv-article">
          {node.title && (
            <div className={headingClass}>
              {node.isSubTitle && <span className="pv-subtitle-mark">子标题 · </span>}
              {node.title}
            </div>
          )}
          {node.contentBlocks.map((block, index) => (
            <PreviewBlock
              key={`${node.id}:${index}`}
              block={block}
              onImageClick={(src) => setLightbox(src)}
            />
          ))}
          {node.contentBlocks.length === 0 && (
            <div className="pv-empty">该章节还没有内容</div>
          )}
        </article>
      </div>
      {lightbox && (
        <Lightbox request={{ src: lightbox, title: node.title }} onClose={() => setLightbox(null)} />
      )}
    </main>
  )
}

function PreviewBlock({
  block,
  onImageClick
}: {
  block: ContentBlock
  onImageClick: (src: string) => void
}): React.JSX.Element {
  switch (block.type) {
    case 'text':
      return <p className="pv-body">{block.content}</p>
    case 'orderedList':
      return (
        <ol className="pv-list">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ol>
      )
    case 'unorderedList':
      return (
        <ul className="pv-list">
          {block.items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )
    case 'table': {
      // 纵向合并与导出同规则（同一个解析函数）：显式跨度优先，老数据退回兼容判定
      const merges = resolveTableMerges({
        data: block.data,
        rowSpans: block.rowSpans,
        mergeVertical: block.mergeVertical
      })
      return (
        <div className="pv-table-wrap">
          {block.caption && <div className="pv-table-caption">{block.caption}</div>}
          <table className="pv-table">
            {block.headers.length > 0 && (
              <thead>
                <tr>
                  {block.headers.map((h, c) => (
                    <th key={c}>{h}</th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {block.data.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => {
                    const m = merges?.[r]?.[c]
                    if (m?.covered === true) return null
                    return (
                      <td key={c} rowSpan={m && m.rowSpan > 1 ? m.rowSpan : undefined}>
                        {cell}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    }
    case 'image':
      return (
        <ImagePreview block={block} onImageClick={onImageClick} />
      )
    case 'mermaid':
      return <MermaidPreview block={block} onImageClick={onImageClick} />
    case 'formula':
      return <FormulaPreview latex={block.latexCode} />
    case 'code':
      return (
        <div className="pv-code-wrap">
          <div className="pv-code-label">{CODE_LANGUAGE_LABELS[block.language] ?? block.language}</div>
          <pre
            className="code-highlight-view"
            dangerouslySetInnerHTML={{ __html: highlightCode(block.code, block.language) }}
          />
        </div>
      )
  }
}

function ImagePreview({
  block,
  onImageClick
}: {
  block: { imagePath: string; caption: string }
  onImageClick: (src: string) => void
}): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    setSrc(null)
    if (block.imagePath) {
      void window.documentor.files.readAsDataUrl(block.imagePath).then((url) => {
        if (!disposed && url) setSrc(url)
      })
    }
    return () => {
      disposed = true
    }
  }, [block.imagePath])

  if (!src) return <></>
  return (
    <figure className="pv-figure">
      <button type="button" className="pv-figure-img" onClick={() => onImageClick(src)}>
        <img src={src} alt={block.caption} />
      </button>
      {block.caption && (
        <figcaption className="pv-figure-caption">{block.caption}</figcaption>
      )}
    </figure>
  )
}

function MermaidPreview({
  block,
  onImageClick
}: {
  block: { caption: string; code: string }
  onImageClick: (src: string) => void
}): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    setSvg(null)
    setError(null)
    if (!block.code.trim()) return
    renderMermaidSvg(block.code)
      .then((s) => {
        if (!disposed) setSvg(s)
      })
      .catch((err: unknown) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      disposed = true
    }
  }, [block.code])

  return (
    <figure className="pv-figure">
      {error ? (
        <div className="pv-mermaid-error">渲染失败：{error}</div>
      ) : svg ? (
        <button
          type="button"
          className="pv-figure-img"
          onClick={() => onImageClick(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)}
        >
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        </button>
      ) : (
        <div className="pv-hint">渲染中…</div>
      )}
      {block.caption && (
        <figcaption className="pv-figure-caption">{block.caption}</figcaption>
      )}
    </figure>
  )
}

function FormulaPreview({ latex }: { latex: string }): React.JSX.Element {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    setHtml(null)
    if (!latex.trim()) return
    void import('katex').then((mod) => {
      if (disposed) return
      setHtml(
        mod.default.renderToString(latex, { throwOnError: false, displayMode: true })
      )
    })
    return () => {
      disposed = true
    }
  }, [latex])
  if (!html) return <></>
  return <div className="pv-formula" dangerouslySetInnerHTML={{ __html: html }} />
}
