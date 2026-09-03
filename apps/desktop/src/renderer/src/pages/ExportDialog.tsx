/**
 * 导出对话框：DOCX 导出（Markdown 预留禁用）、样式模板选择、输出路径。
 */
import { useEffect, useMemo, useState } from 'react'
import type { StyleTemplateDto } from '../../../shared/project'
import { useApp } from '../state/AppContext'

export function ExportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { session, showToast } = useApp()
  const [styles, setStyles] = useState<StyleTemplateDto[]>([])
  const [styleFileKey, setStyleFileKey] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [format, setFormat] = useState<'docx' | 'md'>('docx')
  const [busy, setBusy] = useState(false)

  const info = session?.info

  useEffect(() => {
    void window.documentor.templates.listStyles().then((list) => {
      setStyles(list)
      if (!info) return
      // 默认选中与工程模板关联的样式
      void window.documentor.templates.listStructures().then((structures) => {
        const match = structures.find((s) => s.name === info.templateName)
        const initial = match?.styleFileKey || list[0]?.fileKey || ''
        setStyleFileKey(initial)
      })
    })
    if (info) {
      setOutputPath(`${info.projectDir.replace(/\\/g, '/')}/${info.name}.docx`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selectedStyle = useMemo(
    () => styles.find((s) => s.fileKey === styleFileKey) ?? null,
    [styles, styleFileKey]
  )

  const canExport =
    !!styleFileKey && outputPath.trim().length > 0 && !busy && !!info

  const doExport = async (): Promise<void> => {
    if (!canExport) return
    setBusy(true)
    try {
      const result = await window.documentor.export.docx({
        styleFileKey,
        outputPath: outputPath.trim()
      })
      showToast({
        kind: 'info',
        text: `已导出 DOCX（${result.paragraphCount} 条指令 · 克隆列表组 ${result.clonedGroups}）`
      })
      onClose()
    } catch (err) {
      showToast({ kind: 'error', text: `导出失败：${err instanceof Error ? err.message : String(err)}` })
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
              Markdown <span className="settings-hint">（功能预留）</span>
            </label>
          </section>

          <section className="settings-group">
            <h3>样式模板</h3>
            <select
              className="be-select export-style-select"
              value={styleFileKey}
              onChange={(e) => setStyleFileKey(e.target.value)}
            >
              {styles.map((s) => (
                <option key={s.fileKey} value={s.fileKey}>
                  {s.name} · v{s.version || '1.0'}
                </option>
              ))}
            </select>
            {selectedStyle?.description && (
              <p className="settings-hint export-style-desc">{selectedStyle.description}</p>
            )}
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
            {format === 'docx' ? '导出为 Word 可直接打开的标准 DOCX' : ''}
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
