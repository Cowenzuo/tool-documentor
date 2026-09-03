/**
 * 导出对话框：DOCX 导出（Markdown 预留禁用）。
 * 样式模板下拉 = 该结构模板声明的候选集合（软校验：不可用项禁用并显示原因；
 * 全部不可用 → 导出禁用 + 提示）。
 */
import { useEffect, useMemo, useState } from 'react'
import type { StyleCandidateDto } from '../../../shared/project'
import { useApp } from '../state/AppContext'

export function ExportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { session, showToast } = useApp()
  const [candidates, setCandidates] = useState<StyleCandidateDto[]>([])
  const [styleFileKey, setStyleFileKey] = useState('')
  const [outputPath, setOutputPath] = useState('')
  const [format, setFormat] = useState<'docx' | 'md'>('docx')
  const [busy, setBusy] = useState(false)

  const info = session?.info

  useEffect(() => {
    if (!info) return
    void window.documentor.templates.styleCandidates(info.templateName).then((list) => {
      setCandidates(list)
      const preferred =
        list.find((c) => c.isDefault && c.available) ?? list.find((c) => c.available)
      setStyleFileKey(preferred?.fileKey ?? '')
    })
    setOutputPath(`${info.projectDir.replace(/\\/g, '/')}/${info.name}.docx`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const selected = useMemo(
    () => candidates.find((c) => c.fileKey === styleFileKey) ?? null,
    [candidates, styleFileKey]
  )
  const anyAvailable = candidates.some((c) => c.available)

  const canExport =
    !!selected &&
    selected.available &&
    outputPath.trim().length > 0 &&
    !busy &&
    !!info

  const doExport = async (): Promise<void> => {
    if (!canExport) return
    setBusy(true)
    try {
      const result = await window.documentor.export.docx({
        styleFileKey,
        outputPath: outputPath.trim()
      })
      const warnText = result.warnings.length > 0 ? `；${result.warnings.length} 处样式键缺失` : ''
      showToast({
        kind: result.warnings.length > 0 ? 'error' : 'info',
        text: `已导出 DOCX（${result.paragraphCount} 条指令 · 克隆列表组 ${result.clonedGroups}）${warnText}`
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
            <div className="export-style-row">
              <select
                className="be-select export-style-select"
                value={styleFileKey}
                onChange={(e) => setStyleFileKey(e.target.value)}
                disabled={candidates.length === 0}
              >
                {candidates.map((c) => (
                  <option
                    key={c.fileKey}
                    value={c.fileKey}
                    disabled={!c.available}
                    title={c.available ? c.description : `不可用：${c.missingKeys.join('、')}`}
                  >
                    {c.name} · v{c.version || '1.0'}
                    {c.isDefault ? '（默认）' : ''}
                    {c.available ? '' : `（不可用：缺 ${c.missingKeys.join('、')}）`}
                  </option>
                ))}
              </select>
            </div>
            {!anyAvailable && (
              <p className="settings-hint export-style-desc">
                该结构模板没有可用的样式模板，无法导出。
                {candidates.length > 0
                  ? `缺失明细：${candidates.map((c) => `${c.name}(${c.missingKeys.join('、')})`).join('；')}`
                  : '请检查结构模板声明的 styleTemplates。'}
              </p>
            )}
            {anyAvailable && selected?.description && (
              <p className="settings-hint export-style-desc">{selected.description}</p>
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
            {canExport
              ? '导出为 Word 可直接打开的标准 DOCX'
              : !anyAvailable
                ? '无可用样式模板，导出已禁用'
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
