/**
 * 左栏：模板目录里的模板列表。
 * 结构模板可选可改（新建在这一段，改名与删除在右键菜单里）；样式模板可选可看对照表，
 * 改名与删除同样在右键菜单里——改名只写模板自己那一个 JSON，对照表在右栏改。
 * 身份是 uuid，由程序生成、界面不显示：列表上写的是名字，主名后面跟副名。
 * 目录级问题（目录不存在、子目录缺失、目录名不是 uuid 等）单独一行一条地提示；
 * 旧格式目录那一条旁边给一个迁移动作。
 */
import { useCallback, useRef, useState, type JSX } from 'react'
import type { TemplateDirSnapshotDto, TemplateEntryDto } from '../../../../shared/project'
import { ContextMenu, useContextMenu, type MenuItem } from './ContextMenu'
import { IssueLine, jsonTip } from './fields'
import { ImportIcon, PlusIcon } from './icons'
import type { TemplateEditorStatus, TemplateOpenKind } from './useTemplateEditor'

interface TemplateListProps {
  status: TemplateEditorStatus
  dirSnapshot: TemplateDirSnapshotDto | null
  /** 眼前开的是哪一类（结构 / 样式），与 openUuid 一起决定哪一行高亮 */
  openKind: TemplateOpenKind | null
  openUuid: string | null
  busy: boolean
  dirty: boolean
  onOpen: (entry: TemplateEntryDto) => void
  onOpenStyle: (entry: TemplateEntryDto) => void
  onCreate: (input: { cn: string; en?: string; defaultStyleUuid?: string }) => Promise<boolean>
  /** 导入自备样式：源是 .docx 或已解包的骨架目录 */
  onImport: (input: { cn: string; en?: string; source: string }) => Promise<boolean>
  /** 迁移旧格式目录：分配 uuid、改目录与文件名、引用换 uuid、清单退场 */
  onMigrate: () => Promise<boolean>
  /** 选一个 .docx / 一个目录（对话框在主进程） */
  onPickDocx: () => Promise<string | null>
  onPickDirectory: () => Promise<string | null>
  onRename: (input: { cn: string; en?: string }) => Promise<boolean>
  onRemove: () => Promise<boolean>
  /** 样式模板的改名与删除：与结构模板那两条同形状 */
  onRenameStyle: (input: { cn: string; en?: string }) => Promise<boolean>
  onRemoveStyle: () => Promise<boolean>
}

type Mode = 'none' | 'create' | 'rename' | 'remove' | 'import'

/** 两段列表之间的分隔条高度（px），与 template.css 的 .tpl-pane-split 一致 */
const PANE_HANDLE = 5
/** 每段至少留这么高：一行标题加一条条目 */
const PANE_MIN = 96
const PANE_SPLIT_KEY = 'layout.templateListPaneSplit'

/**
 * 上半段（结构模板）的高度。返回 null 表示还没拖过：两段等分。
 * 拖过之后按拖出来的高度记在本机，下次打开还是这个高度。
 */
function readPaneSplit(): number | null {
  try {
    const saved = Number.parseInt(localStorage.getItem(PANE_SPLIT_KEY) ?? '', 10)
    if (Number.isFinite(saved) && saved >= PANE_MIN) return saved
  } catch {
    /* 忽略：读不到就等分 */
  }
  return null
}

/**
 * 校验结论徽标：红=错误、黄=提示，数字与顶部那两个同源。
 * 光一个数字没人看得懂，所以徽标上挂一句话说清它是什么、以及"这里能不能改"。
 */
function badges(entry: TemplateEntryDto): JSX.Element | null {
  if (entry.errors === 0 && entry.warnings === 0) return null
  const counts = [
    entry.errors > 0 ? `${entry.errors} 个错误` : '',
    entry.warnings > 0 ? `${entry.warnings} 处提示` : ''
  ]
    .filter((part) => part !== '')
    .join(' · ')
  // 徽标上只有两个数字：悬停要说的是"这两个数字是什么"（红=错误、琥珀=提示），
  // 不是把数字再念一遍，也不是"打开后去哪儿看"那类旁白。
  const hint = `校验结论：${counts}`
  return (
    <span className="tpl-badges" title={hint}>
      {entry.errors > 0 && <span className="tpl-badge tpl-badge-error">{entry.errors}</span>}
      {entry.warnings > 0 && <span className="tpl-badge tpl-badge-warn">{entry.warnings}</span>}
    </span>
  )
}

/** 新建结构模板：uuid 由主进程生成，这里只起名字，并可选一份默认样式 */
function CreateForm({
  styles,
  busy,
  onCancel,
  onSubmit
}: {
  styles: TemplateEntryDto[]
  busy: boolean
  onCancel: () => void
  onSubmit: (input: { cn: string; en?: string; defaultStyleUuid?: string }) => void
}): JSX.Element {
  const [cn, setCn] = useState('')
  const [en, setEn] = useState('')
  const [styleUuid, setStyleUuid] = useState('')
  return (
    <div className="tpl-form">
      <label className="tpl-field">
        <span className="tpl-field-label" title={jsonTip('cn', '中文名作主名')}>
          模板名称
        </span>
        <input
          className="tpl-input"
          value={cn}
          placeholder="给作者看的名字"
          autoFocus
          onChange={(event) => setCn(event.target.value)}
        />
      </label>
      <label className="tpl-field">
        <span className="tpl-field-label" title={jsonTip('en', '英文名作副名，可留空')}>
          英文名<span className="tpl-field-hint">可留空</span>
        </span>
        <input
          className="tpl-input"
          value={en}
          placeholder="English name"
          onChange={(event) => setEn(event.target.value)}
        />
      </label>
      <label className="tpl-field">
        <span className="tpl-field-label" title={jsonTip('defaultStyleUuid', '导出默认取这份')}>
          默认样式<span className="tpl-field-hint">可留空</span>
        </span>
        <select
          className="tpl-select"
          value={styleUuid}
          onChange={(event) => setStyleUuid(event.target.value)}
        >
          <option value="">不指定</option>
          {styles.map((entry) => (
            <option key={entry.uuid} value={entry.uuid}>
              {entry.name}
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
          disabled={busy || cn.trim() === ''}
          onClick={() =>
            onSubmit({
              cn: cn.trim(),
              ...(en.trim() === '' ? {} : { en: en.trim() }),
              ...(styleUuid === '' ? {} : { defaultStyleUuid: styleUuid })
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
 * 两条路走同一套检查（主进程那边），这里只负责选源与起名字；uuid 由主进程生成。
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
  onSubmit: (input: { cn: string; en?: string; source: string }) => void
}): JSX.Element {
  const [cn, setCn] = useState('')
  const [en, setEn] = useState('')
  const [source, setSource] = useState('')
  /** 源是文件还是目录：只影响显示（是不是 .docx 由主进程按实际类型判） */
  const sourceIsDocx = /\.docx$/iu.test(source)
  return (
    <div className="tpl-form">
      <label className="tpl-field">
        <span className="tpl-field-label" title={jsonTip('cn', '中文名作主名')}>
          模板名称
        </span>
        <input
          className="tpl-input"
          value={cn}
          placeholder="给作者看的名字"
          autoFocus
          onChange={(event) => setCn(event.target.value)}
        />
      </label>
      <label className="tpl-field">
        <span className="tpl-field-label" title={jsonTip('en', '英文名作副名，可留空')}>
          英文名<span className="tpl-field-hint">可留空</span>
        </span>
        <input
          className="tpl-input"
          value={en}
          placeholder="English name"
          onChange={(event) => setEn(event.target.value)}
        />
      </label>
      <div className="tpl-field">
        <span className="tpl-field-label" title="不改样式文件 · 导入后生成映射草稿">
          样式文件<span className="tpl-field-hint">Word 文档或已解包目录</span>
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
            选 Word 文档…
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
            选已解包目录…
          </button>
        </div>
        <p className="tpl-note tpl-import-source" title={source}>
          {source === ''
            ? '未选 · 两种都支持，缺必需部件会被拒'
            : `${sourceIsDocx ? 'Word 文档' : '已解包目录'}：${source}`}
        </p>
        {/* 选完之后路径落在这里，也可以直接粘一个进来（改起来不用重新走对话框） */}
        <input
          className="tpl-input tpl-mono tpl-import-path"
          value={source}
          placeholder="样式文件路径 · 可直接粘贴"
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
          disabled={busy || cn.trim() === '' || source === ''}
          onClick={() =>
            onSubmit({
              cn: cn.trim(),
              ...(en.trim() === '' ? {} : { en: en.trim() }),
              source
            })
          }
        >
          导入
        </button>
      </div>
    </div>
  )
}

/**
 * 改名表单（结构与样式共用）：只改中文名与英文名。
 * uuid 是身份、目录与文件名都按它来，所以改名不碰文件、不碰引用、不碰别的模板。
 */
function RenameForm({
  kind,
  busy,
  cn,
  en,
  onCn,
  onEn,
  onCancel,
  onSubmit
}: {
  kind: 'structure' | 'style'
  busy: boolean
  cn: string
  en: string
  onCn: (value: string) => void
  onEn: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
}): JSX.Element {
  return (
    <div className="tpl-form">
      <label className="tpl-field">
        <span className="tpl-field-label" title={jsonTip('cn', '中文名作主名')}>
          模板名称
        </span>
        <input
          className="tpl-input"
          value={cn}
          autoFocus
          onChange={(event) => onCn(event.target.value)}
        />
      </label>
      <label className="tpl-field">
        <span className="tpl-field-label" title={jsonTip('en', '英文名作副名，可留空')}>
          英文名<span className="tpl-field-hint">可留空</span>
        </span>
        <input
          className="tpl-input"
          value={en}
          onChange={(event) => onEn(event.target.value)}
        />
      </label>
      <p className="tpl-note">
        {kind === 'structure'
          ? '改名只写这一个 JSON · 目录与文件名不动'
          : '改名只写这一个 JSON · 引用它默认为样式的结构模板不受影响'}
      </p>
      <div className="tpl-form-foot">
        <button type="button" className="tpl-mini" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button
          type="button"
          className="tpl-mini tpl-primary"
          disabled={busy || cn.trim() === ''}
          onClick={onSubmit}
        >
          确定
        </button>
      </div>
    </div>
  )
}

export function TemplateList(props: TemplateListProps): JSX.Element {
  const { status, dirSnapshot, openKind, openUuid, busy, dirty, onMigrate } = props
  const [mode, setMode] = useState<Mode>('none')
  /** 挂着的那张改名/删除表单是给哪一类条目开的：mode 留着，切回来还是它，换了一类就不拿出来 */
  const [formKind, setFormKind] = useState<'structure' | 'style'>('structure')
  const [renameCn, setRenameCn] = useState('')
  const [renameEn, setRenameEn] = useState('')
  /** 模板那一行的右键菜单（改名 / 删除）：菜单开在右键的那一份上，两类条目共用这一个控件 */
  const menu = useContextMenu<{ entry: TemplateEntryDto }>()
  /** 结构模板那一段的高度；null = 还没拖过，两段等分 */
  const [paneSplit, setPaneSplit] = useState<number | null>(readPaneSplit)
  const panesRef = useRef<HTMLDivElement | null>(null)

  /** 落一个高度：写进 state（界面）并记到本机（下次打开还是这个高度） */
  const commitPaneSplit = useCallback((value: number): void => {
    const box = panesRef.current
    const total = box ? box.getBoundingClientRect().height : 0
    const max = total > 0 ? total - PANE_HANDLE - PANE_MIN : Number.MAX_SAFE_INTEGER
    const next = Math.round(Math.min(Math.max(PANE_MIN, value), Math.max(PANE_MIN, max)))
    setPaneSplit(next)
    try {
      localStorage.setItem(PANE_SPLIT_KEY, String(next))
    } catch {
      /* 忽略：写不进去也不影响本次使用 */
    }
  }, [])

  /** 拖动分隔条：向下拖给结构那一段更多高度，向上拖给样式那一段 */
  const startPaneDrag = useCallback(
    (event: React.MouseEvent): void => {
      event.preventDefault()
      const box = panesRef.current
      if (!box) return
      const startY = event.clientY
      const total = box.getBoundingClientRect().height
      const from = paneSplit ?? Math.round((total - PANE_HANDLE) / 2)
      document.body.classList.add('is-splitting-row')
      const onMove = (ev: MouseEvent): void => commitPaneSplit(from + (ev.clientY - startY))
      const onUp = (): void => {
        document.body.classList.remove('is-splitting-row')
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [commitPaneSplit, paneSplit]
  )

  /** 分隔条也能用键盘推：上下方向键各 16px */
  const nudgePane = useCallback(
    (delta: number): void => {
      const box = panesRef.current
      const total = box ? box.getBoundingClientRect().height : 0
      commitPaneSplit((paneSplit ?? Math.round((total - PANE_HANDLE) / 2)) + delta)
    },
    [commitPaneSplit, paneSplit]
  )

  const structures = dirSnapshot?.structures ?? []
  const styles = dirSnapshot?.styles ?? []

  /** 开一张表单：连它是给哪一类条目开的记下来（表单里的值只对那一类成立） */
  const openForm = (kind: 'structure' | 'style', next: Mode): void => {
    setFormKind(kind)
    setMode(next)
  }

  const selected =
    openKind === 'structure' ? (structures.find((entry) => entry.uuid === openUuid) ?? null) : null
  const openStyle =
    openKind === 'style' ? (styles.find((entry) => entry.uuid === openUuid) ?? null) : null
  /** 改名与删除都落在"当前打开的那一份"上（服务端就是按它读写的） */
  const isOpenEntry =
    openKind === 'structure' && menu.payload !== null && menu.payload.entry.uuid === openUuid
  const isOpenStyleEntry =
    openKind === 'style' && menu.payload !== null && menu.payload.entry.uuid === openUuid

  /** 删除样式时顺口提示一句谁在用它（目录快照里的 usedBy），但不拦删除 */
  const styleUsedBy = openStyle?.usedBy ?? []

  /** 结构模板那一行的菜单两项 */
  const structureMenuItems: MenuItem[] = [
    {
      label: '改名',
      // 菜单项自己是看得懂的：悬停只在灰着的时候说清为什么灰
      title: !isOpenEntry
        ? '改名只作用于当前打开的那一份：先点开这份模板'
        : dirty
          ? '先保存改动'
          : undefined,
      disabled: busy || dirty || !isOpenEntry,
      run: () => {
        setRenameCn(selected?.name ?? '')
        setRenameEn('')
        openForm('structure', 'rename')
      }
    },
    {
      label: '删除',
      title: !isOpenEntry
        ? '删除只作用于当前打开的那一份：先点开这份模板'
        : dirty
          ? '先保存改动'
          : undefined,
      disabled: busy || dirty || !isOpenEntry,
      danger: true,
      run: () => openForm('structure', 'remove')
    }
  ]

  /** 样式模板那一行的菜单两项：与结构同一套行为，提示里点名样式模板 */
  const styleMenuItems: MenuItem[] = [
    {
      label: '改名',
      title: !isOpenStyleEntry
        ? '改名只作用于当前打开的那一份：先点开这份样式模板'
        : dirty
          ? '先保存改动'
          : undefined,
      disabled: busy || dirty || !isOpenStyleEntry,
      run: () => {
        setRenameCn(openStyle?.name ?? '')
        setRenameEn('')
        openForm('style', 'rename')
      }
    },
    {
      label: '删除',
      title: !isOpenStyleEntry
        ? '删除只作用于当前打开的那一份：先点开这份样式模板'
        : dirty
          ? '先保存改动'
          : undefined,
      disabled: busy || dirty || !isOpenStyleEntry,
      danger: true,
      run: () => openForm('style', 'remove')
    }
  ]

  /** 菜单摆哪一套，看它是开在哪一类条目上的 */
  const menuItems = menu.payload?.entry.kind === 'style' ? styleMenuItems : structureMenuItems

  return (
    <section className="tpl-col tpl-col-list" aria-label="模板">
      <header className="tpl-col-head">
        <h2>模板</h2>
      </header>
      <div className="tpl-col-body tpl-col-list-body">
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
                {/* 目录名不是 uuid 的那些：这一条旁边就是迁移动作，旧格式不并存 */}
                {dirSnapshot.issues.some((issue) => issue.rule === 'dir.legacy') && (
                  <button
                    type="button"
                    className="tpl-mini tpl-inline-action"
                    title="旧格式目录：分配 uuid、改目录与文件名、引用换 uuid、清单退场"
                    disabled={busy || dirty}
                    onClick={() => void onMigrate()}
                  >
                    迁移旧格式
                  </button>
                )}
              </div>
            )}

            {/* 两段各占一块、各滚各的：结构模板在上，样式模板在下。
                谁多谁少在中间那条分隔条上定，内容再多也是自己那一块里滚，不挤对面 */}
            <div className="tpl-panes" ref={panesRef}>
              <div
                className={`tpl-pane${paneSplit === null ? '' : ' is-sized'}`}
                style={paneSplit === null ? undefined : { height: paneSplit }}
              >
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

                <div className="tpl-pane-body">
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
                      <li key={entry.uuid}>
                        <button
                          type="button"
                          className={`tpl-item${
                            openKind === 'structure' && entry.uuid === openUuid ? ' is-selected' : ''
                          }`}
                          data-entry={entry.uuid}
                          data-kind="structure"
                          onClick={() => props.onOpen(entry)}
                          onContextMenu={(event) => {
                            event.preventDefault()
                            // 右键不开这份模板（那会牵动未保存确认）：菜单就作用在右键的那一份上
                            menu.openIn({ entry }, event.clientX, event.clientY)
                          }}
                          onKeyDown={(event) => {
                            // 键盘也要能开这单（Windows 的习惯键：Shift+F10 或菜单键）
                            if (
                              event.key !== 'ContextMenu' &&
                              !(event.shiftKey && event.key === 'F10')
                            ) {
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
                          <span className="tpl-item-name">{entry.name}</span>
                          {/* 问题徽标紧跟名字（它是"这份模板有事"的提示） */}
                          {badges(entry)}
                          {/* 副名贴在行的右端：与主名分开，扫一眼就知道哪个是中文名 */}
                          {entry.en === '' ? null : (
                            <span className="tpl-item-en" title="英文名">
                              {entry.en}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {/* 改名 / 删除表单只跟"开着的那一份"走：切到别处先收起来（mode 留着，切回来还是它）。
                    两类条目各有一张同名的表单，值不一样，所以还要 formKind 对上才拿出来 */}
                {mode === 'rename' && formKind === 'structure' && openKind === 'structure' && selected && (
                  <RenameForm
                    kind="structure"
                    busy={busy}
                    cn={renameCn}
                    en={renameEn}
                    onCn={setRenameCn}
                    onEn={setRenameEn}
                    onCancel={() => setMode('none')}
                    onSubmit={() => {
                      void props
                        .onRename({
                          cn: renameCn.trim(),
                          ...(renameEn.trim() === '' ? {} : { en: renameEn.trim() })
                        })
                        .then((ok) => {
                          if (ok) setMode('none')
                        })
                    }}
                  />
                )}

                {mode === 'remove' && formKind === 'structure' && openKind === 'structure' && selected && (
                  <div className="tpl-form">
                    <p className="tpl-note">删除「{selected.name}」？整份目录一起删</p>
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

                </div>
              </div>

              <div
                className="tpl-pane-split"
                role="separator"
                aria-orientation="horizontal"
                aria-label="调整两段列表高度"
                tabIndex={0}
                onMouseDown={startPaneDrag}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                  event.preventDefault()
                  nudgePane(event.key === 'ArrowUp' ? -16 : 16)
                }}
              />

              {/* 样式模板这一段：点开看的是**对照表**（逻辑键 → 骨架样式），不是样式文件本身。
                  骨架里的字节程序一个字节都不改；改名与删除动的是样式自己，在下面那一行的右键菜单里。 */}
              <div className="tpl-pane">
                <div className="tpl-section-head" title="样式文件由作者提供 · 此处只改对照表">
                  <h3>样式模板</h3>
                  {/* 导入：把自备的样式文件铺进模板目录，并按样式名生成映射草稿 */}
                  <button
                    type="button"
                    className="tpl-icon-btn"
                    disabled={busy}
                    title="导入样式文件 · Word 文档或已解包目录"
                    aria-label="导入样式文件"
                    onClick={() => setMode(mode === 'import' ? 'none' : 'import')}
                  >
                    <ImportIcon />
                  </button>
                </div>

                <div className="tpl-pane-body">
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
                        <li key={entry.uuid}>
                          <button
                            type="button"
                            className={`tpl-item${
                              openKind === 'style' && entry.uuid === openUuid ? ' is-selected' : ''
                            }`}
                            data-entry={entry.uuid}
                            data-kind="style"
                            onClick={() => props.onOpenStyle(entry)}
                            onContextMenu={(event) => {
                              event.preventDefault()
                              // 与结构模板那一行同一套：右键不打开这份（那会牵动未保存确认），
                              // 菜单就作用在右键的那一份上
                              menu.openIn({ entry }, event.clientX, event.clientY)
                            }}
                            onKeyDown={(event) => {
                              // 键盘也要能开这单（Windows 的习惯键：Shift+F10 或菜单键）
                              if (
                                event.key !== 'ContextMenu' &&
                                !(event.shiftKey && event.key === 'F10')
                              ) {
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
                            <span className="tpl-item-name">{entry.name}</span>
                            {badges(entry)}
                            {/* 副名贴在行的右端：与主名分开，扫一眼就知道哪个是中文名 */}
                            {entry.en === '' ? null : (
                              <span className="tpl-item-en" title="英文名">
                                {entry.en}
                              </span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* 样式那一份的改名表单：与结构同一套摆法，落点是样式自己那一个 JSON */}
                  {mode === 'rename' && formKind === 'style' && openKind === 'style' && openStyle && (
                    <RenameForm
                      kind="style"
                      busy={busy}
                      cn={renameCn}
                      en={renameEn}
                      onCn={setRenameCn}
                      onEn={setRenameEn}
                      onCancel={() => setMode('none')}
                      onSubmit={() => {
                        void props
                          .onRenameStyle({
                            cn: renameCn.trim(),
                            ...(renameEn.trim() === '' ? {} : { en: renameEn.trim() })
                          })
                          .then((ok) => {
                            if (ok) setMode('none')
                          })
                      }}
                    />
                  )}

                  {/* 删除样式：被谁用只说一句，不拦——找不到样式就是悬挂，由用户重选 */}
                  {mode === 'remove' && formKind === 'style' && openKind === 'style' && openStyle && (
                    <div className="tpl-form">
                      <p className="tpl-note">删除「{openStyle.name}」？整份目录含骨架一起删</p>
                      {styleUsedBy.length > 0 && (
                        <p className="tpl-note">
                          这些结构模板把它当默认样式：{styleUsedBy.join('、')}
                        </p>
                      )}
                      <div className="tpl-form-foot">
                        <button type="button" className="tpl-mini" onClick={() => setMode('none')}>
                          取消
                        </button>
                        <button
                          type="button"
                          className="tpl-mini tpl-danger"
                          disabled={busy}
                          onClick={() => {
                            void props.onRemoveStyle().then((ok) => {
                              if (ok) setMode('none')
                            })
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
      {/* 改名与删除收敛到模板那一行的右键菜单里：列表上不再常驻一排按钮。两类条目共用这个菜单，
          摆哪一套看它开在哪一类上；两项都作用在**这份模板自己**身上，而服务端是按"当前打开的
          那一份"改的，所以右键别的模板时它们灰着，提示里说清要先点开它。 */}
      {menu.payload && (
        <ContextMenu
          control={menu}
          className="tpl-list-menu"
          label="模板操作"
          head={menu.payload.entry.name}
          items={menuItems}
        />
      )}
    </section>
  )
}

export default TemplateList
