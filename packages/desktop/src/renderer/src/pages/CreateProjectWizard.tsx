/**
 * 新建工程向导（模态）：工作区 + 工程名 + 模板卡片。
 */
import { useEffect, useMemo, useState } from 'react'
import type { AppConfigDto, StructureTemplateDto, TemplateLoadReport } from '../../../shared/project'
import { useApp } from '../state/AppContext'

export function CreateProjectWizard({
  onClose
}: {
  onClose: () => void
}): React.JSX.Element {
  const { createProject, busy } = useApp()
  const [workspaceDir, setWorkspaceDir] = useState('')
  const [name, setName] = useState('')
  const [templateUuid, setTemplateUuid] = useState('')
  const [structures, setStructures] = useState<StructureTemplateDto[]>([])
  const [category, setCategory] = useState('全部')
  const [report, setReport] = useState<TemplateLoadReport | null>(null)

  useEffect(() => {
    void window.documentor.settings.get().then((cfg: AppConfigDto) => {
      if (cfg.default_project_dir) setWorkspaceDir(cfg.default_project_dir)
    })
    void window.documentor.templates.listStructures().then((list) => setStructures(list))
    void window.documentor.templates.diagnose().then(setReport)
  }, [])

  /** 一套模板都没有时，把「哪个目录、为什么」直接摆出来，别让用户对着空白猜 */
  const emptyHint = useMemo((): string => {
    const configured = report?.dirs.filter((d) => d.dir.trim()) ?? []
    if (configured.length === 0) {
      return '还没有配置模板目录。请到 设置 → 模板目录 添加模板目录。'
    }
    const broken = configured.filter((d) => d.loadFailed)
    if (broken.length === 0) return '无可用结构模板'
    return broken
      .map((d) => {
        const why = !d.exists ? '目录不存在' : d.reasons[0] ?? '未加载到任何模板'
        return `${d.dir} —— ${why}`
      })
      .join('；')
  }, [report])

  const categories = useMemo(
    () => ['全部', ...new Set(structures.map((s) => s.category).filter(Boolean))],
    [structures]
  )
  const visible = useMemo(
    () =>
      category === '全部' ? structures : structures.filter((s) => s.category === category),
    [structures, category]
  )

  const canCreate = workspaceDir.trim().length > 0 && name.trim().length > 0 && !!templateUuid && !busy

  const submit = async (): Promise<void> => {
    if (!canCreate) return
    const ok = await createProject({
      workspaceDir: workspaceDir.trim(),
      name: name.trim(),
      templateUuid
    })
    if (ok) onClose()
  }

  return (
    <div className="wizard-overlay" role="dialog" aria-modal="true" aria-label="新建工程">
      <div className="wizard">
        <header className="wizard-head">
          <h2>新建工程</h2>
          <button type="button" className="tb-win-close-like" aria-label="关闭" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="wizard-body">
          <div className="wizard-config">
            <label className="w-field">
              <span>工作区目录</span>
              <div className="w-row">
                <input
                  value={workspaceDir}
                  onChange={(e) => setWorkspaceDir(e.target.value)}
                  placeholder="工程将创建在此目录下"
                />
                <button
                  type="button"
                  className="be-btn"
                  onClick={() => {
                    void window.documentor.dialog.selectDirectory().then((dir) => {
                      if (dir) setWorkspaceDir(dir)
                    })
                  }}
                >
                  浏览…
                </button>
              </div>
            </label>
            <label className="w-field">
              <span>工程名</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：示例工程（将创建同名文件夹）"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                }}
              />
            </label>
          </div>

          <div className="w-templates">
            <div className="w-cats">
              {categories.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={category === c ? 'active' : ''}
                  onClick={() => setCategory(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="w-cards">
              {visible.map((s) => (
                <button
                  key={s.uuid}
                  type="button"
                  className={`w-card${templateUuid === s.uuid ? ' selected' : ''}`}
                  onClick={() => setTemplateUuid(s.uuid)}
                >
                  <span className="w-card-name">{s.name}</span>
                  <span className="w-card-desc">{s.description}</span>
                  <span className="w-card-ver">v{s.version || '1.0'}</span>
                </button>
              ))}
              {visible.length === 0 && (
                <div className="w-empty">
                  {structures.length === 0 ? emptyHint : '该分类下无模板'}
                </div>
              )}
            </div>
          </div>
        </div>
        <footer className="wizard-foot">
          <span className="wizard-error">
            {name.trim() && workspaceDir.trim() ? '将创建目录：' + workspaceDir.trim() + '\\' + name.trim() : ''}
          </span>
          <button type="button" className="be-btn be-btn-primary" disabled={!canCreate} onClick={() => void submit()}>
            创建工程
          </button>
        </footer>
      </div>
    </div>
  )
}
