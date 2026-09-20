/**
 * 静态预览：按文档顺序渲染整篇（标题 + 内容块），排版规则对齐导出：
 * 表题注在上、图题注在下且居中；代码/公式高亮渲染。
 *
 * 整篇而不是只看当前节点——章节之间的层级上下文与版面连续性只有连起来看才有。
 * 块内容按需挂载（滚动到附近才渲染），否则上百张图的工程一进来就要把所有图读成 dataURL。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { resolveTableMerges } from '@documentor/core/table-merge'
import type { ContentBlock } from '@documentor/core/blocks'
import type { NodeDto } from '../../../../shared/project'
import { useApp, useSelectedNode } from '../../state/AppContext'
import { renderMermaidSvg } from '../../utils/mermaid'
import { highlightCode } from '../../utils/highlight'
import { Lightbox } from '../Lightbox'
import { CODE_LANGUAGE_LABELS } from './blockTypes'

/** 前序遍历：整篇预览按这个顺序铺节点 */
function flattenNodes(root: NodeDto | null): NodeDto[] {
  if (!root) return []
  const out: NodeDto[] = []
  const walk = (node: NodeDto): void => {
    out.push(node)
    for (const child of node.children) walk(child)
  }
  walk(root)
  return out
}

function headingClassOf(node: NodeDto): string {
  return node.headingLevel === 0
    ? 'pv-h1'
    : `pv-h${Math.min(6, Math.max(1, node.headingLevel))}`
}

/**
 * 滚动到附近才渲染：用一个哨兵元素观察，进了视口（提前 600px）就永久挂上。
 * 挂上不撤，避免来回滚动时反复读图与重排。
 */
function LazySection({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (shown) return
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setShown(true)
      },
      { rootMargin: '600px 0px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [shown])

  return <div ref={ref}>{shown ? children : null}</div>
}

export function PreviewPage(): React.JSX.Element {
  const { session, selectedId } = useApp()
  const node = useSelectedNode()
  const [lightbox, setLightbox] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /**
   * 栏宽按样式骨架的正文区算（twips → px：1 缇 = 1/1440 英寸，96 DPI 下除以 15）。
   * 拿不到就退回 CSS 里的兜底值，A4 加 1800 缇页边距的口径。
   */
  const [pageWidthPx, setPageWidthPx] = useState<number | null>(null)
  /** 交付前检查：只显示会影响导出的问题 */
  const [issues, setIssues] = useState<string[]>([])

  useEffect(() => {
    let disposed = false
    void window.documentor.project
      .precheck()
      .then((r) => {
        if (disposed) return
        const list: string[] = []
        if (r.images.missing.length > 0) {
          const head = r.images.missing.slice(0, 3).join('、')
          const more = r.images.missing.length > 3 ? ` 等 ${r.images.missing.length} 张` : ''
          list.push(`有图片找不到文件：${head}${more}`)
        }
        if (r.mermaid.total > 0 && !r.mermaid.converterAvailable) {
          list.push(`${r.mermaid.total} 幅流程图将按文本导出，图不会出现在正式文档里`)
        }
        if (r.tables.overLimit > 0) {
          list.push(`${r.tables.overLimit} 个表格超出界面上限，导出照常，编辑时建议拆表`)
        }
        setIssues(list)
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [session?.info.dprojPath, session?.root])

  const nodes = useMemo(() => flattenNodes(session?.root ?? null), [session?.root])

  useEffect(() => {
    let disposed = false
    void window.documentor.project
      .pageTextWidth()
      .then((twips) => {
        if (disposed || twips === null) return
        setPageWidthPx(Math.round(twips / 15))
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [session?.info.dprojPath])

  useEffect(() => {
    setLightbox(null)
  }, [node?.id])

  /**
   * 打开预览或换章节时，滚到当前章节而不是回顶部：
   * 整篇预览里"当前在哪"比"从头看"更有用，回顶部反而要用户自己找。
   */
  useLayoutEffect(() => {
    if (!selectedId) return
    const el = document.getElementById(`pv-node-${selectedId}`)
    el?.scrollIntoView({ block: 'start' })
  }, [selectedId])

  if (nodes.length === 0) {
    return (
      <main className="node-page node-page-empty">
        <div className="np-hint">从左侧结构树选择章节查看排版</div>
      </main>
    )
  }

  return (
    <main className="node-page">
      <div className="pv-scroll" ref={scrollRef}>
        {issues.length > 0 && (
          <div className="pv-precheck" role="status">
            <span className="pv-precheck-title">导出前检查</span>
            <ul>
              {issues.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </div>
        )}
        <article
          className="pv-article"
          style={pageWidthPx ? ({ '--pv-page-width': `${pageWidthPx}px` } as React.CSSProperties) : undefined}
        >
          {nodes.map((item) => (
            <section
              key={item.id}
              id={`pv-node-${item.id}`}
              className={`pv-node${item.id === selectedId ? ' is-current' : ''}`}
            >
              {item.title && (
                <div className={headingClassOf(item)}>
                  {item.isSubTitle && <span className="pv-subtitle-mark">子标题 · </span>}
                  {item.title}
                </div>
              )}
              <LazySection>
                {item.contentBlocks.map((block, index) => (
                  <PreviewBlock
                    key={`${item.id}:${index}`}
                    block={block}
                    onImageClick={(src) => setLightbox(src)}
                  />
                ))}
              </LazySection>
            </section>
          ))}
          {nodes.every((n) => n.contentBlocks.length === 0) && (
            <div className="pv-empty">整篇还没有内容</div>
          )}
        </article>
      </div>
      {lightbox && (
        <Lightbox
          request={{ src: lightbox, title: node?.title ?? '' }}
          onClose={() => setLightbox(null)}
        />
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
      // 纵向合并与导出同规则（同一个解析函数）：显式跨度逐格优先，兼容判定补空。
      // 列数按表头、cols 与数据行的最大值取，与导出一致
      const merges = resolveTableMerges({
        data: block.data,
        headers: block.headers,
        cols: block.cols,
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
  /** 读不到文件要说话：以前整块直接不渲染，用户以为这块内容没了 */
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let disposed = false
    setSrc(null)
    setMissing(false)
    if (block.imagePath) {
      void window.documentor.files.readAsDataUrl(block.imagePath).then((url) => {
        if (disposed) return
        setSrc(url)
        setMissing(url === null)
      })
    }
    return () => {
      disposed = true
    }
  }, [block.imagePath])

  if (!block.imagePath) {
    return (
      <figure className="pv-figure">
        <div className="pv-missing">未选择图片</div>
        {block.caption && <figcaption className="pv-figure-caption">{block.caption}</figcaption>}
      </figure>
    )
  }
  if (missing) {
    return (
      <figure className="pv-figure">
        <div className="pv-missing">图片文件缺失：{block.imagePath}</div>
        {block.caption && <figcaption className="pv-figure-caption">{block.caption}</figcaption>}
      </figure>
    )
  }
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
