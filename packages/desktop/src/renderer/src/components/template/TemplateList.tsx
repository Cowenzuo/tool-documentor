/**
 * 左栏：模板目录里的模板列表。
 * 结构模板可选可改（新建/改名/删除都在这一段）；样式模板可选可看对照表
 * （样式文件本身不改，改的是结构与样式之间那张对照表）。
 * 目录级问题（清单缺失、目录不存在、目录没登记等）单独一行一条地提示。
 */
import { useState, type JSX } from 'react'
import type { TemplateDirSnapshotDto, TemplateEntryDto } from '../../../../shared/project'
import { ContextMenu, useContextMenu } from './ContextMenu'
import { IssueLine, jsonTip } from './fields'
import { ImportIcon, PlusIcon } from './icons'
import type { TemplateEditorStatus, TemplateOpenKind } from './useTemplateEditor'

interface TemplateListProps {
  status: TemplateEditorStatus
  dirSnapshot: TemplateDirSnapshotDto | null
  /** 眼前开的是哪一类（结构 / 样式），与 openId 一起决定哪一行高亮 */
  openKind: TemplateOpenKind | null
  openId: string | null
  busy: boolean
  dirty: boolean
  onOpen: (entry: TemplateEntryDto) => void
  onOpenStyle: (entry: TemplateEntryDto) => void
  onCreate: (input: { id: string; name: string; styleTemplate?: string }) => Promise<boolean>
  /** 导入自备样式：源是 .docx 或已解包的骨架目录 */
  onImport: (input: { id: string; name: string; source: string }) => Promise<boolean>
  /** 选一个 .docx / 一个目录（对话框在主进程） */
  onPickDocx: () => Promise<string | null>
  onPickDirectory: () => Promise<string | null>
  onRename: (input: { newId: string; name: string }) => Promise<boolean>
  onRemove: () => Promise<boolean>
}

type Mode = 'none' | 'create' | 'rename' | 'remove' | 'import'

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
      : `校验结论：${counts}。打开它看对照表：每一行配到了哪条样式、缺了什么。样式文件本身不改`
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

/**
 * 导入自备样式（PLAN-11 批次 3 步骤 4）：源可以是 `.docx`，也可以是**已经解包**的骨架目录。
 * 两条路走同一套检查（主进程那边），这里只负责选源、起 id 与名字。
 */
function ImportForm({
  busy,
  onPickDocx,
  onPickDirectory,
  onCancel,
  onSubmit
}: {
  busy: boolean
  onPickDocx: () => Promise<string | null>
  onPickDirectory: () => Promise<string | null>
  onCancel: () => void
  onSubmit: (input: { id: string; name: string; source: string }) => void
}): JSX.Element {
  const [id, setId] = useState('')
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const problem = idProblem(id)
  const idOk = id.trim() !== '' && problem === null
  /** 源是文件还是目录：只影响显示（是不是 .docx 由主进程按实际类型判） */
  const sourceIsDocx = /\.docx$/iu.test(source)
  return (
    <div className="tpl-form">
      <label className="tpl-field">
        <span className="tpl-field-label" title={jsonTip('id', '同时是目录名与 manifest 里的 id')}>
          模板 id<span className="tpl-field-hint">目录名</span>
        </span>
        <input
          className="tpl-input tpl-mono"
          value={id}
          placeholder="my-style"
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
      <div className="tpl-field">
        <span
          className="tpl-field-label"
          title="程序只解包与检查，一个字节的 XML 都不改；导入后按样式名生成映射草稿"
        >
          样式文件<span className="tpl-field-hint">.docx 或已解包的骨架目录</span>
        </span>
        <div className="tpl-import-pick">
          <button
            type="button"
            className="tpl-mini"
            disabled={busy}
            onClick={() => {
              void onPickDocx().then((picked) => {
                if (picked) setSource(picked)
              })
            }}
          >
            选 .docx…
          </button>
          <button
            type="button"
            className="tpl-mini"
            disabled={busy}
            onClick={() => {
              void onPickDirectory().then((picked) => {
                if (picked) setSource(picked)
              })
            }}
          >
            选骨架目录…
          </button>
        </div>
        <p className="tpl-note tpl-import-source" title={source}>
          {source === ''
            ? '还没选：两种都行，缺 word/styles.xml 这类必需部件会被拒'
            : `${sourceIsDocx ? '.docx' : '骨架目录'}：${source}`}
        </p>
        {/* 选完之后路径落在这里，也可以直接粘一个进来（改起来不用重新走对话框） */}
        <input
          className="tpl-input tpl-mono tpl-import-path"
          value={source}
          placeholder="样式文件路径（也可以直接粘贴）"
          aria-label="样式文件路径"
          onChange={(event) => setSource(event.target.value)}
        />
      </div>
      <div className="tpl-form-foot">
        <button type="button" className="tpl-mini" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className="tpl-mini tpl-primary"
          disabled={busy || !idOk || name.trim() === '' || source === ''}
          onClick={() => onSubmit({ id: id.trim(), name: name.trim(), source })}
        >
          导入
        </button>
      </div>
    </div>
  )
}

export function TemplateList(props: TemplateListProps): JSX.Element {  const { status, dirSnapshot, openKind, openId, busy, dirty } = props
  const [mode, setMode] = useState<Mode>('none')
  const [renameValue, setRenameValue] = useState('')
  const [renameId, setRenameId] = useState('')
  /** 结构模板那一行的右键菜单（改名 / 删除）：菜单开在右键的那一份上 */
  const menu = useContextMenu<{ entry: TemplateEntryDto }>()

  const structures = dirSnapshot?.structures ?? []
  const styles = dirSnapshot?.styles ?? []
  const selected = structures.find((entry) => entry.id === openId) ?? null
  /** 改名与删除都落在"当前打开的那一份"上（服务端就是按它读写的） */
  const isOpenEntry =
    openKind === 'structure' && menu.payload !== null && menu.payload.entry.id === openId

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
              {/* 新建放在这一行的右端（与"选中哪一份"无关，是整段列表的动作） */}
              <button
                type="button"
                className="tpl-icon-btn"
                disabled={busy}
                title="新建结构模板"
                aria-label="新建结构模板"
                onClick={() => setMode(mode === 'create' ? 'none' : 'create')}
              >
                <PlusIcon />
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
                      className={`tpl-item${
                        openKind === 'structure' && entry.id === openId ? ' is-selected' : ''
                      }`}
                      data-entry={entry.id}
                      data-kind="structure"
                      title={entry.file}
                      onClick={() => props.onOpen(entry)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        // 右键不开这份模板（那会牵动未保存确认）：菜单就作用在右键的那一份上
                        menu.openIn({ entry }, event.clientX, event.clientY)
                      }}
                      onKeyDown={(event) => {
                        // 键盘也要能开这单（Windows 的习惯键：Shift+F10 或菜单键）
                        if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
                          return
                        }
                        event.preventDefault()
                        const rect = event.currentTarget.getBoundingClientRect()
                        menu.openIn(
                          { entry },
                          Math.round(rect.right - 8),
                          Math.round(rect.bottom - 4)
                        )
                      }}
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

            {/* 改名 / 删除表单只跟结构模板走：样式视图开着时先把它们收起来（mode 留着，
                切回结构模板还是一样） */}
            {mode === 'rename' && openKind === 'structure' && selected && (
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

            {mode === 'remove' && openKind === 'structure' && selected && (
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

            {/* 样式模板这一段：点开看的是**对照表**（逻辑键 → 骨架样式），不是样式文件本身。
                样式文件（stylemap 的骨架）程序一个字节都不改，所以这里没有新建/改名/删除。 */}
            <div
              className="tpl-section-head"
              title="样式文件由作者提供，程序只解包与检查；这里改的是结构与样式之间的对照表（styleMap 与题注编号）"
            >
              <h3>样式模板</h3>
              <span className="tpl-count">点开看对照表</span>
              {/* 导入：把自备的样式文件铺进模板目录，并按样式名生成映射草稿 */}
              <button
                type="button"
                className="tpl-icon-btn"
                disabled={busy}
                title="导入自备样式（.docx 或已解包的骨架目录）"
                aria-label="导入自备样式"
                onClick={() => setMode(mode === 'import' ? 'none' : 'import')}
              >
                <ImportIcon />
              </button>
            </div>

            {mode === 'import' && (
              <ImportForm
                busy={busy}
                onPickDocx={props.onPickDocx}
                onPickDirectory={props.onPickDirectory}
                onCancel={() => setMode('none')}
                onSubmit={(input) => {
                  void props.onImport(input).then((ok) => {
                    if (ok) setMode('none')
                  })
                }}
              />
            )}
            {styles.length === 0 ? (
              <p className="tpl-empty">这个目录里还没有样式模板</p>
            ) : (
              <ul className="tpl-items">
                {styles.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className={`tpl-item${
                        openKind === 'style' && entry.id === openId ? ' is-selected' : ''
                      }`}
                      data-entry={entry.id}
                      data-kind="style"
                      title={`打开这份样式对照表：${entry.file}`}
                      onClick={() => props.onOpenStyle(entry)}
                    >
                      <span className="tpl-item-name">{entry.name || entry.id}</span>
                      {/* 与结构模板同一顺序：问题徽标跟名字，id · fileKey 放最后 */}
                      {badges(entry, 'style')}
                      <span className="tpl-item-id">
                        {entry.id} · {styleFileKey(entry)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      {/* 改名与删除收敛到结构模板那一行的右键菜单里：列表上不再常驻一排按钮。
          两项都作用在**这份模板自己**身上，而服务端是按"当前打开的那一份"改的，
          所以右键别的模板时它们灰着，提示里说清要先点开它。 */}
      {menu.payload && (
        <ContextMenu
          control={menu}
          className="tpl-list-menu"
          label="模板操作"
          head={menu.payload.entry.name || menu.payload.entry.id}
          headTitle={menu.payload.entry.file}
          items={[
            {
              label: '改名',
              title: !isOpenEntry
                ? '改名作用在当前打开的那一份：先点开这份模板'
                : dirty
                  ? '先保存改动'
                  : '改这份模板的 id 与名称',
              disabled: busy || dirty || !isOpenEntry,
              run: () => {
                setRenameValue(selected?.name || selected?.id || '')
                setRenameId(selected?.id || '')
                setMode('rename')
              }
            },
            {
              label: '删除',
              title: !isOpenEntry
                ? '删除作用在当前打开的那一份：先点开这份模板'
                : dirty
                  ? '先保存改动'
                  : '删除这份模板（删除前会先备份）',
              disabled: busy || dirty || !isOpenEntry,
              danger: true,
              run: () => setMode('remove')
            }
          ]}
        />
      )}
    </section>
  )
}

export default TemplateList
