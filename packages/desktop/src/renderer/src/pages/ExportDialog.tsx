/**
 * 导出对话框：DOCX 导出（Markdown 预留禁用）。
 * 样式模板下拉 = 模板目录里能读出来的**全部**样式，默认选中结构里写的那一份，可以改选。
 * 新口径下样式一律完整，所以没有"这份结构与这份样式不匹配"这回事。
 */
import { useEffect, useMemo, useState } from 'react'
import type { FigureCountsDto, StyleOptionDto } from '../../../shared/project'
import { useApp } from '../state/AppContext'
import { errorText } from '../utils/errorText'

export function ExportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { session, showToast } = useApp()
  const [candidates, setCandidates] = useState<StyleOptionDto[]>([])
  const [styleUuid, setStyleUuid] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [format, setFormat] = useState<'docx' | 'md'>('docx')
  const [figures, setFigures] = useState<FigureCountsDto | null>(null)
  const [busy, setBusy] = useState(false)

  const info = session?.info

  useEffect(() => {
    if (!info) return
    void window.documentor.templates.styles(info.templateUuid).then((list) => {
      setCandidates(list)
      const preferred =
        list.find((c) => c.isDefault) ?? list[0]
      setStyleUuid(preferred?.uuid ?? '')
    })
    void window.documentor.export.figureCounts().then(setFigures, () => setFigures(null))
    setOutputPath(`${info.projectDir.replace(/\\/g, '/')}/${info.name}.docx`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = useMemo(
    () => candidates.find((c) => c.uuid === styleUuid) ?? null,
    [candidates, styleUuid]
  )
  /** 一份样式都没有（模板目录还没放样式模板）：导出无从谈起 */
  const hasStyles = candidates.length > 0

  const canExport = !!selected && outputPath.trim().length > 0 && !busy && !!info

  const doExport = async (): Promise<void> => {
    if (!canExport) return
    setBusy(true)
    try {
      const result = await window.documentor.export.docx({
        styleUuid,
        outputPath: outputPath.trim()
      })
      const f = result.figures
      const failCount = f?.failed.length ?? 0
      const warnText = result.warnings.length > 0 ? `；${result.warnings.length} 处警告` : ''
      // 只有"确有失败"才用红色；成功但有提醒用琥珀色；一切正常用中性色
      const kind = failCount > 0 ? 'error' : result.warnings.length > 0 ? 'warn' : 'info'
      let figureText = ''
      if (f && f.total > 0) {
        if (f.unavailable) {
          // 转换服务整体不可用：total 张全都没嵌进去，不能让人以为正文里有图
          figureText = f.total === 1 ? '（图以文本形式导出）' : `（${f.total} 张图以文本形式导出）`
        } else if (failCount === f.total) {
          figureText = f.total === 1 ? '（图以文本形式导出）' : `（${f.total} 张图以文本形式导出）`
        } else if (failCount > 0) {
          figureText = `（含 ${f.embedded} 张图，另有 ${failCount} 张以文本形式导出）`
        } else if (f.embedded > 0) {
          figureText = `（含 ${f.embedded} 张图）`
        }
      }
      const failText =
        failCount > 0
          ? `；以文本形式导出：${f!.failed
              .slice(0, 3)
              .map((x) => `${x.caption}`)
              .join('、')}`
          : ''
      showToast({
        kind,
        text: `已导出 DOCX` + figureText + warnText + failText + `\n${result.outputPath}`
      })
      onClose()
    } catch (err) {
      showToast({ kind: 'error', text: `导出失败：${errorText(err)}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wizard-overlay" role="dialog" aria-modal="true" aria-label="导出 DOCX">
      <div className="wizard settings-dialog">
        <header className="wizard-head">
          <h2>导出文档</h2>
          <button type="button" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="settings-body">
          <section className="settings-group">
            <h3>格式</h3>
            <label className="export-radio">
              <input
                type="radio"
                checked={format === 'docx'}
                onChange={() => {
                  setFormat('docx')
                  setOutputPath((p) => p.replace(/\.md$/i, '.docx'))
                }}
              />
              DOCX（Word 文档）
            </label>
            <label className="export-radio export-radio-disabled">
              <input type="radio" disabled checked={false} />
              Markdown
            </label>
          </section>

          <section className="settings-group">
            <h3>样式模板</h3>
            <div className="export-style-row">
              <select
                className="be-select export-style-select"
                value={styleUuid}
                onChange={(e) => setStyleUuid(e.target.value)}
                disabled={candidates.length === 0}
              >
                {candidates.map((c) => (
                  <option key={c.uuid} value={c.uuid} title={c.name}>
                    {c.name} · v{c.version || '1.0'}
                    {c.isDefault ? ' · 默认' : ''}
                  </option>
                ))}
              </select>
            </div>
            {!hasStyles && (
              <p className="settings-hint export-style-desc">
                模板目录里没有样式模板，先放一份进去
              </p>
            )}
          </section>

          <section className="settings-group">
            <h3>图表嵌入</h3>
            {figures && (figures.images > 0 || figures.mermaid > 0) ? (
              <p className="settings-hint export-style-desc">
                将一并嵌入 {figures.images + figures.mermaid} 张图
                {figures.mermaid > 0 && !figures.mermaidAvailable && (
                  <span style={{ color: 'var(--danger)' }}>
                    {' '}
                    · 其中 {figures.mermaid} 张以文本形式导出，双击编辑暂不可用
                  </span>
                )}
              </p>
            ) : (
              <p className="settings-hint export-style-desc">没有图片</p>
            )}
          </section>

          <section className="settings-group">
            <h3>表格</h3>
            <p className="settings-hint export-style-desc">
              {figures && figures.tables > 0
                ? `${figures.tables} 个表格按 Word 原生表格导出`
                : '没有表格'}
            </p>
          </section>

          <section className="settings-group">
            <h3>输出路径</h3>
            <div className="w-row">
              <input
                value={outputPath}
                onChange={(e) => setOutputPath(e.target.value)}
                placeholder="输出 .docx 文件路径"
              />
              <button
                type="button"
                className="be-btn"
                onClick={() => {
                  void window.documentor.dialog.savePath({ defaultPath: outputPath }).then((p) => {
                    if (p) setOutputPath(p)
                  })
                }}
              >
                浏览…
              </button>
            </div>
          </section>
        </div>
        <footer className="wizard-foot">
          <span className="wizard-error">
            {canExport
              ? '导出为 Word 可直接打开的标准 DOCX'
              : !hasStyles
                ? '模板目录里没有样式模板，导出已禁用'
                : ''}
          </span>
          <button
            type="button"
            className="be-btn be-btn-primary"
            disabled={!canExport}
            onClick={() => void doExport()}
          >
            {busy ? '导出中…' : '导出'}
          </button>
        </footer>
      </div>
    </div>
  )
}
