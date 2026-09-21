/**
 * 左栏：模板目录里的模板列表。
 * 结构模板可选可改（新建/改名/删除都在这一段）；样式模板还是一段只读清单
 * （对照表编辑在下一批），这一点在界面上写明「只读」并给悬停说明，不靠猜。
 * 目录级问题（清单缺失、目录不存在、目录没登记等）单独一行一条地提示。
 */
import { useState, type JSX } from 'react'
import type { TemplateDirSnapshotDto, TemplateEntryDto } from '../../../../shared/project'
import { IssueLine, jsonTip } from './fields'
import type { TemplateEditorStatus } from './useTemplateEditor'

interface TemplateListProps {
  status: TemplateEditorStatus
  dirSnapshot: TemplateDirSnapshotDto | null
  selectedId: string | null
  busy: boolean
  dirty: boolean
  onOpen: (entry: TemplateEntryDto) => void
  onCreate: (input: { id: string; name: string; styleTemplate?: string }) => Promise<boolean>
  onRename: (input: { newId: string; name: string }) => Promise<boolean>
  onRemove: () => Promise<boolean>
}

type Mode = 'none' | 'create' | 'rename' | 'remove'

/** id 同时是目录名，规则与主进程一致（单段目录名，不含路径分隔符与控制字符） */
const INVALID_ID = /[\\/:*?"<>|\u0000-\u001f]/u

function idProblem(id: string): string | null {
  if (id === '') return null
  if (id === '.' || id === '..') return 'id 不能是 . 或 ..'
  if (INVALID_ID.test(id)) return 'id 里不能有 \\ / : * ? " < > |'
  if (id.endsWith('.') || id.endsWith(' ')) return 'id 不能以点或空格结尾'
  return null
}

/**
 * 校验结论徽标：红=错误、黄=提示，数字与顶部那两个同源。
 * 光一个数字没人看得懂，所以徽标上挂一句话说清它是什么、以及"这里能不能改"。
 */
function badges(entry: TemplateEntryDto, what: 'structure' | 'style'): JSX.Element | null {
  if (entry.errors === 0 && entry.warnings === 0) return null
  const counts = [
    entry.errors > 0 ? `${entry.errors} 个错误` : '',
    entry.warnings > 0 ? `${entry.warnings} 处提示` : ''
  ]
    .filter((part) => part !== '')
    .join(' · ')
  const hint =
    what === 'structure'
      ? `校验结论：${counts}。打开这份模板，右栏与页脚会逐条说清`
      : `校验结论：${counts}。样式模板这一批只列出来（改对照表还没做），要改请直接改样式文件`
  return (
    <span className="tpl-badges" title={hint}>
      {entry.errors > 0 && <span className="tpl-badge tpl-badge-error">{entry.errors}</span>}
      {entry.warnings > 0 && <span className="tpl-badge tpl-badge-warn">{entry.warnings}</span>}
    </span>
  )
}

/**
 * 结构模板 `styleTemplate` 要写的是样式对照表的 fileKey（文件名去掉 .json），
 * 不是样式模板的 id：真实模板里两者并不一样（id 438c-srs / fileKey 438c-srs-stylemap）。
 */
function styleFileKey(entry: TemplateEntryDto): string {
  return entry.file.replace(/\.json$/i, '')
}

function CreateForm({
  styles,
  busy,
  onCancel,
  onSubmit
}: {
  styles: TemplateEntryDto[]
  busy: boolean
  onCancel: () => void
  onSubmit: (input: { id: string; name: string; styleTemplate?: string }) => void
}): JSX.Element {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [style, setStyle] = useState('')
  const problem = idProblem(id)
  const idOk = id.trim() !== '' && problem === null
  return (
    <div className="tpl-form">
      <label className="tpl-field">
        <span className="tpl-field-label" title={jsonTip('id', '同时是目录名与 manifest 里的 id')}>
          模板 id<span className="tpl-field-hint">目录名</span>
        </span>
        <input
          className="tpl-input tpl-mono"
          value={id}
          placeholder="my-template"
          autoFocus
          onChange={(event) => setId(event.target.value)}
        />
      </label>
      {problem && <p className="tpl-note tpl-note-bad">{problem}</p>}
      <label className="tpl-field">
        <span className="tpl-field-label" title={jsonTip('name')}>
          模板名称
        </span>
        <input
          className="tpl-input"
          value={name}
          placeholder="给作者看的名字"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="tpl-field">
        <span
          className="tpl-field-label"
          title={jsonTip('styleTemplate', '写样式对照表的文件键：stylemap 文件名去掉 .json')}
        >
          配对的样式模板<span className="tpl-field-hint">可留空</span>
        </span>
        <select
          className="tpl-select"
          value={style}
          onChange={(event) => setStyle(event.target.value)}
        >
          <option value="">不指定</option>
          {styles.map((entry) => (
            <option key={entry.id} value={styleFileKey(entry)}>
              {entry.name || entry.id}（{styleFileKey(entry)}）
            </option>
          ))}
        </select>
      </label>
      <div className="tpl-form-foot">
        <button type="button" className="tpl-mini" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className="tpl-mini tpl-primary"
          disabled={busy || !idOk || name.trim() === ''}
          onClick={() =>
            onSubmit({
              id: id.trim(),
              name: name.trim(),
              ...(style ? { styleTemplate: style } : {})
            })
          }
        >
          新建
        </button>
      </div>
    </div>
  )
}

export function TemplateList(props: TemplateListProps): JSX.Element {
  const { status, dirSnapshot, selectedId, busy, dirty } = props
  const [mode, setMode] = useState<Mode>('none')
  const [renameValue, setRenameValue] = useState('')
  const [renameId, setRenameId] = useState('')

  const structures = dirSnapshot?.structures ?? []
  const styles = dirSnapshot?.styles ?? []
  const selected = structures.find((entry) => entry.id === selectedId) ?? null

  /** 改名表单：id 与原来不同（且合法、不撞已有 id）才动目录与文件名 */
  const renameIdValue = renameId.trim()
  const idChanged = selected !== null && renameIdValue !== selected.id
  const renameIdProblem = ((): string | null => {
    if (selected === null || !idChanged) return null
    const basic = idProblem(renameIdValue)
    if (basic !== null) return basic
    if (structures.some((entry) => entry.id === renameIdValue)) {
      return `这个目录里已经有 id 为「${renameIdValue}」的结构模板`
    }
    return null
  })()

  return (
    <section className="tpl-col tpl-col-list" aria-label="模板">
      <header className="tpl-col-head">
        <h2>模板</h2>
      </header>
      <div className="tpl-col-body">
        {!dirSnapshot ? (
          <>
            <p className="tpl-empty">
              {status === 'ready' ? '还没有配置模板目录' : '正在读取模板目录…'}
            </p>
            {status === 'failed' && (
              <p className="tpl-note tpl-note-bad">读不到模板目录，可以点上面的「重新加载」</p>
            )}
          </>
        ) : (
          <>
            {dirSnapshot.issues.length > 0 && (
              <div className="tpl-dir-issues">
                {dirSnapshot.issues.map((issue, index) => (
                  <IssueLine key={`${issue.rule}-${index}`} issue={issue} />
                ))}
              </div>
            )}

            <div className="tpl-section-head">
              <h3>结构模板</h3>
              <button
                type="button"
                className="tpl-mini"
                disabled={busy}
                onClick={() => setMode(mode === 'create' ? 'none' : 'create')}
              >
                新建
              </button>
            </div>

            {mode === 'create' && (
              <CreateForm
                styles={styles}
                busy={busy}
                onCancel={() => setMode('none')}
                onSubmit={(input) => {
                  void props.onCreate(input).then((ok) => {
                    if (ok) setMode('none')
                  })
                }}
              />
            )}

            {structures.length === 0 ? (
              <p className="tpl-empty">这个目录里还没有结构模板</p>
            ) : (
              <ul className="tpl-items">
                {structures.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`tpl-item${entry.id === selectedId ? ' is-selected' : ''}`}
                      title={entry.file}
                      onClick={() => props.onOpen(entry)}
                    >
                      <span className="tpl-item-name">{entry.name || entry.id}</span>
                      {/* 问题徽标紧跟名字（它是"这份模板有事"的提示），id 是给对照用的，挪到最后 */}
                      {badges(entry, 'structure')}
                      <span className="tpl-item-id">{entry.id}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {selected && (
              <div className="tpl-form-foot tpl-list-foot">
                <button
                  type="button"
                  className="tpl-mini"
                  disabled={busy || dirty}
                  title={dirty ? '先保存改动' : '改这份模板的名字'}
                  onClick={() => {
                    setRenameValue(selected.name || selected.id)
                    setRenameId(selected.id)
                    setMode('rename')
                  }}
                >
                  改名
                </button>
                <button
                  type="button"
                  className="tpl-mini tpl-danger"
                  disabled={busy || dirty}
                  title={dirty ? '先保存改动' : '删除这份模板'}
                  onClick={() => setMode('remove')}
                >
                  删除
                </button>
              </div>
            )}

            {mode === 'rename' && selected && (
              <div className="tpl-form">
                <label className="tpl-field">
                  <span className="tpl-field-label" title={jsonTip('id', '目录名，也是文件名前缀；改它会连同目录与文件一起改名')}>
                    模板 id<span className="tpl-field-hint">目录名</span>
                  </span>
                  <input
                    className="tpl-input tpl-mono"
                    value={renameId}
                    autoFocus
                    onChange={(event) => setRenameId(event.target.value)}
                  />
                </label>
                {renameIdProblem && <p className="tpl-note tpl-note-bad">{renameIdProblem}</p>}
                <label className="tpl-field">
                  <span className="tpl-field-label" title={jsonTip('name', '工程锚点按它认模板；改了老工程会配不上')}>
                    模板名称
                  </span>
                  <input
                    className="tpl-input"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                  />
                </label>
                <p className="tpl-note">
                  {idChanged
                    ? `改 id 会把目录与文件名一起改成 ${renameId.trim()}（改前整份备份）`
                    : '只改名字，目录名与文件名不动'}
                </p>
                <div className="tpl-form-foot">
                  <button type="button" className="tpl-mini" onClick={() => setMode('none')}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="tpl-mini tpl-primary"
                    disabled={busy || renameValue.trim() === '' || renameId.trim() === '' || renameIdProblem !== null}
                    onClick={() => {
                      void props
                        .onRename({ newId: renameId.trim(), name: renameValue.trim() })
                        .then((ok) => {
                          if (ok) setMode('none')
                        })
                    }}
                  >
                    确定
                  </button>
                </div>
              </div>
            )}

            {mode === 'remove' && selected && (
              <div className="tpl-form">
                <p className="tpl-note">删除「{selected.name || selected.id}」？删除前会先备份这份模板。</p>
                <div className="tpl-form-foot">
                  <button type="button" className="tpl-mini" onClick={() => setMode('none')}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="tpl-mini tpl-danger"
                    disabled={busy}
                    onClick={() => {
                      void props.onRemove().then((ok) => {
                        if (ok) setMode('none')
                      })
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            )}

            <div
              className="tpl-section-head"
              title="样式模板来自外部样式文件，这一批只列出来（结构与样式的对照表编辑还没做）；要改样式请直接改包里的 stylemap 与骨架"
            >
              <h3>样式模板</h3>
              <span className="tpl-count">只读</span>
            </div>
            {styles.length === 0 ? (
              <p className="tpl-empty">这个目录里还没有样式模板</p>
            ) : (
              <ul className="tpl-items">
                {styles.map((entry) => (
                  <li key={entry.id}>
                    <div
                      className="tpl-item is-readonly"
                      title={`${entry.file}（只读：改样式请直接改这个文件）`}
                    >
                      <span className="tpl-item-name">{entry.name || entry.id}</span>
                      {/* 与结构模板同一顺序：问题徽标跟名字，id · fileKey 放最后 */}
                      {badges(entry, 'style')}
                      <span className="tpl-item-id">
                        {entry.id} · {styleFileKey(entry)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  )
}

export default TemplateList
