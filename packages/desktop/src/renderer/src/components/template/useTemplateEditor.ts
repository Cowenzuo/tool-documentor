/**
 * 模板编辑页的状态：自己的根、自己的状态，不碰 AppContext 的会话与编辑器组件树
 * （PLAN-11 第 3 节：两套状态互不引用）。
 *
 * 模型：主进程是文件的权威，这里是**内存草稿**——所有编辑只落在 doc 上，
 * 点保存才写文件；每次改动用本地规则即时校验一次，保存结果里的 issues 覆盖显示。
 * 主进程侧还没接上时（`window.documentor.templateEditor` 不存在或调用抛错）按"读不到"处理，
 * 页面显示等待文案，不崩。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  TemplateDirSnapshotDto,
  TemplateEditorSnapshotDto,
  TemplateEntryDto,
  TemplateIssueDto,
  TemplateReadResult,
  TemplateStyleReadResult
} from '../../../../shared/project'
import {
  ROOT_PATH,
  addBlockAt,
  branchKeys,
  childKindFor,
  createTemplateBlock,
  createTemplateNode,
  duplicateBlockAt,
  duplicateNodeAt as duplicateNodeAtInDoc,
  expandableKeys,
  headingLevel,
  insertChildAt,
  insertSiblingAfter,
  moveBlockIn,
  moveNodeIn,
  nodeAt,
  nodeKind,
  nodeType,
  pathKey,
  patchBlockAt,
  patchNodeAt,
  rawChildren,
  removeBlockAt,
  removeNodeAt as removeNodeAtInDoc,
  type NodePath,
  type TemplateDoc,
  type TemplateObject
} from './templateDoc'
import { validateStructureDoc } from './templateValidate'

export type TemplateEditorStatus = 'loading' | 'ready' | 'failed'
export type TemplateIssuesSource = 'local' | 'server'

/** 页面上的一条结果提示；detail 放备份路径或主进程给的错误原文 */
export interface TemplateNotice {
  kind: 'info' | 'warn' | 'error'
  text: string
  detail?: string
  /**
   * 只在"草稿没再动过"时还成立的回执（例如「已保存 11:36:48」）：
   * 一动笔就该从状态栏撤下来，不然它会替一份有改动的草稿说"已保存"。
   */
  staleOnEdit?: boolean
}

/**
 * 有未保存改动时切换对象（模板/目录）或重新加载，要先问一句，避免草稿被静默丢掉。
 * `entry` 两种模板都算：结构模板与样式模板（对照表）都可能开在眼前。
 */
export type TemplatePending =
  | { kind: 'entry'; entry: TemplateEntryDto }
  | { kind: 'dir'; dir: string }
  | { kind: 'reload' }

/** 眼前开的是哪一类：结构模板（节点树 + 表单）还是样式模板（对照表） */
export type TemplateOpenKind = 'structure' | 'style'

type EditorApi = Window['documentor']['templateEditor']

/**
 * 拿主进程的桥：主进程那条线可能还没落地，或 preload 还没挂上。
 * 这里失败只意味着"读不到"，不能把整页带崩。
 */
function templateApi(): EditorApi | null {
  try {
    return window.documentor?.templateEditor ?? null
  } catch {
    return null
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 选中目录：保留当前目录，否则用默认目录，再否则第一份 */
function pickDir(snapshot: TemplateEditorSnapshotDto, current: string | null): string | null {
  const has = (dir: string): boolean => snapshot.dirs.some((d) => d.dir === dir)
  if (current && has(current)) return current
  if (snapshot.defaultDir && has(snapshot.defaultDir)) return snapshot.defaultDir
  return snapshot.dirs[0]?.dir ?? null
}

/** 选中模板：保留当前模板，否则第一份 */
function pickEntry(dirSnapshot: TemplateDirSnapshotDto | null, current: string | null): TemplateEntryDto | null {
  if (!dirSnapshot) return null
  if (current) {
    const hit = dirSnapshot.structures.find((entry) => entry.id === current)
    if (hit) return hit
  }
  return dirSnapshot.structures[0] ?? null
}

export interface UseTemplateEditorResult {
  status: TemplateEditorStatus
  snapshot: TemplateEditorSnapshotDto | null
  dirSnapshot: TemplateDirSnapshotDto | null
  dir: string | null
  entry: TemplateEntryDto | null
  doc: TemplateDoc | null
  /** 眼前开的是结构模板还是样式模板；都没开是 null */
  openKind: TemplateOpenKind | null
  /** 开着的样式模板（对照表）与其读回来的结果 */
  styleEntry: TemplateEntryDto | null
  style: TemplateStyleReadResult | null
  busy: boolean
  dirty: boolean
  issues: TemplateIssueDto[]
  issuesSource: TemplateIssuesSource
  notice: TemplateNotice | null
  pending: TemplatePending | null
  selectedPath: NodePath
  selectedNode: TemplateObject | null
  expanded: Set<string>
  reload: () => Promise<void>
  requestReload: () => void
  requestDir: (dir: string) => void
  requestEntry: (entry: TemplateEntryDto) => void
  requestStyle: (entry: TemplateEntryDto) => void
  confirmPending: () => void
  cancelPending: () => void
  save: () => Promise<void>
  createTemplate: (input: { id: string; name: string; styleTemplate?: string }) => Promise<boolean>
  removeTemplate: () => Promise<boolean>
  renameTemplate: (input: { newId: string; name: string }) => Promise<boolean>
  dismissNotice: () => void
  selectNode: (path: NodePath) => void
  revealNode: (path: NodePath) => void
  toggleExpand: (key: string) => void
  expandAll: () => void
  collapseAll: () => void
  patchSelectedNode: (patch: TemplateObject) => void
  addChildAt: (path: NodePath) => void
  addSiblingAt: (path: NodePath) => void
  duplicateNodeAt: (path: NodePath) => void
  moveNodeAt: (path: NodePath, delta: -1 | 1) => void
  removeNodeAt: (path: NodePath) => void
  toggleBranchAt: (path: NodePath) => void
  patchBlock: (index: number, patch: TemplateObject) => void
  addBlock: (type: string, index?: number) => void
  duplicateBlock: (index: number) => void
  moveBlock: (index: number, delta: -1 | 1) => void
  removeBlock: (index: number) => void
}

export function useTemplateEditor(): UseTemplateEditorResult {
  const [status, setStatus] = useState<TemplateEditorStatus>('loading')
  const [snapshot, setSnapshot] = useState<TemplateEditorSnapshotDto | null>(null)
  const [dir, setDir] = useState<string | null>(null)
  const [entryId, setEntryId] = useState<string | null>(null)
  const [doc, setDoc] = useState<TemplateDoc | null>(null)
  const [file, setFile] = useState<string | null>(null)
  const [serverIssues, setServerIssues] = useState<TemplateIssueDto[]>([])
  const [issuesSource, setIssuesSource] = useState<TemplateIssuesSource>('local')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<TemplateNotice | null>(null)
  const [pending, setPending] = useState<TemplatePending | null>(null)
  const [selectedPath, setSelectedPath] = useState<NodePath>(ROOT_PATH)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  /**
   * 样式侧：开着的样式模板 id 与读回来的对照表。
   * 与结构侧的草稿并存——两份模板各留各的，在左栏来回点不用重读（结构草稿也不会被样式覆盖）。
   * `styleIdRef.current !== null` 就表示"眼前是样式视图"。
   */
  const [styleId, setStyleId] = useState<string | null>(null)
  const [style, setStyle] = useState<TemplateStyleReadResult | null>(null)

  const dirRef = useRef<string | null>(null)
  const entryIdRef = useRef<string | null>(null)
  useEffect(() => {
    dirRef.current = dir
  }, [dir])
  useEffect(() => {
    entryIdRef.current = entryId
  }, [entryId])

  const dirSnapshot = useMemo(
    () => snapshot?.dirs.find((item) => item.dir === dir) ?? null,
    [snapshot, dir]
  )
  const entry = useMemo(
    () => dirSnapshot?.structures.find((item) => item.id === entryId) ?? null,
    [dirSnapshot, entryId]
  )
  const styleEntry = useMemo(
    () => dirSnapshot?.styles.find((item) => item.id === styleId) ?? null,
    [dirSnapshot, styleId]
  )
  const openKind: TemplateOpenKind | null = styleId !== null ? 'style' : doc !== null ? 'structure' : null
  const selectedNode = useMemo(() => (doc ? nodeAt(doc, selectedPath) : null), [doc, selectedPath])

  /**
   * 即时校验：doc 每次改动重算一次（本地规则，与主进程同一套判定与文案）。
   * 读过/存过之后显示主进程返回的那一份——"用返回的 issues 刷新问题列表"。
   */
  const localIssues = useMemo(() => {
    if (!doc) return []
    const opts: { id?: string; file?: string } = {}
    if (entryId) opts.id = entryId
    if (file) opts.file = file
    return validateStructureDoc(doc, opts)
  }, [doc, entryId, file])

  const issues = issuesSource === 'server' ? serverIssues : localIssues
  /** 状态栏与页脚看的是"眼前这一份"的结论：样式视图就用样式侧的 */
  const visibleIssues = openKind === 'style' ? (style?.issues ?? []) : issues

  /** 打开一份读回来的结构模板：草稿、选中、展开、问题列表一起归位 */
  const applyRead = useCallback((result: TemplateReadResult) => {
    setDoc(result.doc)
    setFile(result.file)
    setDir(result.dir)
    setEntryId(result.id)
    setServerIssues(result.issues)
    setIssuesSource('server')
    setSelectedPath(ROOT_PATH)
    setExpanded(expandableKeys(result.doc))
    setDirty(false)
    // 换了一份模板：上一条回执说的已经不是眼前这份了
    setNotice(null)
    setPending(null)
  }, [])

  const readEntry = useCallback(
    async (api: EditorApi, targetDir: string, target: TemplateEntryDto): Promise<void> => {
      setBusy(true)
      try {
        applyRead(await api.read({ dir: targetDir, id: target.id }))
        // 结构视图在前：样式那一段收起来（草稿留着，点回样式不用重读）
        setStyleId(null)
      } catch (err) {
        setNotice({ kind: 'error', text: '读不到这份模板', detail: errorText(err) })
      } finally {
        setBusy(false)
      }
    },
    [applyRead]
  )

  /**
   * 打开一份样式模板：读回对照表（stylemap 原文 + 骨架样式表 + 必需键与共用影响面）。
   * 结构草稿不动也不清——两份模板各留各的，来回点不用重读、也不会把结构草稿弄丢。
   */
  const readStyleEntry = useCallback(
    async (api: EditorApi, targetDir: string, target: TemplateEntryDto): Promise<void> => {
      setBusy(true)
      try {
        setStyle(await api.readStyle({ dir: targetDir, id: target.id }))
        setStyleId(target.id)
        setDir(targetDir)
        setNotice(null)
        setPending(null)
      } catch (err) {
        setNotice({ kind: 'error', text: '读不到这份样式模板', detail: errorText(err) })
      } finally {
        setBusy(false)
      }
    },
    []
  )

  /** 只刷新目录与徽标，不动当前草稿（保存后用） */
  const refreshSnapshot = useCallback(async (): Promise<void> => {
    const api = templateApi()
    if (!api) return
    try {
      setSnapshot(await api.snapshot())
    } catch {
      /* 忽略：徽标刷新失败不影响正在编辑的草稿 */
    }
  }, [])

  /** 重新加载：目录全貌再加当前模板的原文 */
  const reload = useCallback(async (): Promise<void> => {
    const api = templateApi()
    if (!api) {
      setStatus('failed')
      return
    }
    setBusy(true)
    setStatus('loading')
    setNotice(null)
    try {
      const next = await api.snapshot()
      setSnapshot(next)
      setStatus('ready')
      const nextDir = pickDir(next, dirRef.current)
      const nextDirSnapshot = next.dirs.find((item) => item.dir === nextDir) ?? null
      setDir(nextDir)
      const nextEntry = pickEntry(nextDirSnapshot, entryIdRef.current)
      if (nextEntry && nextDir) {
        setEntryId(nextEntry.id)
        await readEntry(api, nextDir, nextEntry)
      } else {
        setDoc(null)
        setFile(null)
        setEntryId(null)
        setServerIssues([])
        setDirty(false)
      }
      // 重新加载是"按文件重来"：样式那一段也收起来（点回去会重新读）
      setStyleId(null)
      setStyle(null)
    } catch (err) {
      setStatus('failed')
      setNotice({ kind: 'error', text: '读不到模板目录', detail: errorText(err) })
    } finally {
      setBusy(false)
    }
  }, [readEntry])

  useEffect(() => {
    void reload()
  }, [reload])

  const switchDir = useCallback(
    (nextDir: string): void => {
      const api = templateApi()
      setDir(nextDir)
      // 换目录：样式那一段收起来（它属于上一个目录）
      setStyleId(null)
      setStyle(null)
      const target = snapshot?.dirs.find((item) => item.dir === nextDir) ?? null
      const nextEntry = pickEntry(target, null)
      if (!api || !nextEntry) {
        setDoc(null)
        setFile(null)
        setEntryId(null)
        setServerIssues([])
        setDirty(false)
        setPending(null)
        return
      }
      setEntryId(nextEntry.id)
      void readEntry(api, nextDir, nextEntry)
    },
    [readEntry, snapshot]
  )

  const requestDir = useCallback(
    (nextDir: string): void => {
      if (nextDir === dir) return
      if (dirty) {
        setPending({ kind: 'dir', dir: nextDir })
        return
      }
      switchDir(nextDir)
    },
    [dir, dirty, switchDir]
  )

  /**
   * 点一份结构模板。两种情况都算"换对象"：
   *   - 眼前是样式视图 → 收起来，回到已经在内存里的结构草稿（同一份就不重读）；
   *   - 眼前是另一份结构 → 读它。
   * 有未保存改动时先问一句（草稿只有一份，换对象就会丢）。
   */
  const requestEntry = useCallback(
    (target: TemplateEntryDto): void => {
      const alreadyOpen = styleId === null && target.id === entryId && doc !== null
      if (alreadyOpen) return
      if (dirty) {
        setPending({ kind: 'entry', entry: target })
        return
      }
      const api = templateApi()
      if (!api || !dir) return
      if (styleId !== null && target.id === entryId && doc !== null) {
        // 结构草稿还在内存里：只是把样式视图收起来，不重读
        setStyleId(null)
        setNotice(null)
        return
      }
      setEntryId(target.id)
      void readEntry(api, dir, target)
    },
    [dir, dirty, doc, entryId, readEntry, styleId]
  )

  /** 点一份样式模板：读回对照表。有未保存的结构改动时同样先问一句。 */
  const requestStyle = useCallback(
    (target: TemplateEntryDto): void => {
      if (styleId === target.id) return
      if (dirty) {
        setPending({ kind: 'entry', entry: target })
        return
      }
      const api = templateApi()
      if (!api || !dir) return
      void readStyleEntry(api, dir, target)
    },
    [dir, dirty, readStyleEntry, styleId]
  )

  const confirmPending = useCallback((): void => {
    const action = pending
    setPending(null)
    if (!action) return
    if (action.kind === 'reload') {
      void reload()
      return
    }
    if (action.kind === 'dir') {
      switchDir(action.dir)
      return
    }
    const api = templateApi()
    if (!api || !dir) return
    if (action.entry.kind === 'style') {
      void readStyleEntry(api, dir, action.entry)
      return
    }
    setEntryId(action.entry.id)
    void readEntry(api, dir, action.entry)
  }, [dir, pending, readEntry, readStyleEntry, reload, switchDir])

  const cancelPending = useCallback((): void => setPending(null), [])

  /** 「重新加载」：草稿有改动时先确认——重新读一遍会把草稿丢掉 */
  const requestReload = useCallback((): void => {
    if (dirty) {
      setPending({ kind: 'reload' })
      return
    }
    void reload()
  }, [dirty, reload])

  // ================= 草稿改动 =================

  /**
   * 所有编辑的唯一入口：只改内存草稿（写文件只在 save 里发生）。
   * 改完立刻把问题列表切回"本地即时结论"。
   */
  const mutate = useCallback(
    (op: (current: TemplateDoc) => TemplateDoc): void => {
      if (!doc) return
      const next = op(doc)
      if (next === doc) return
      setDoc(next)
      setDirty(true)
      setIssuesSource('local')
      // 又动笔了：状态栏里那条「已保存」不再成立
      setNotice((current) => (current?.staleOnEdit ? null : current))
    },
    [doc]
  )

  const save = useCallback(async (): Promise<void> => {
    const api = templateApi()
    if (!api || !doc || !dir || !entryId) return
    setBusy(true)
    try {
      const result = await api.save({ dir, id: entryId, doc })
      setServerIssues(result.issues)
      setIssuesSource('server')
      setDirty(false)
      const time = result.savedAt.slice(11, 19)
      setNotice({
        kind: 'info',
        text: result.backupPath
          ? `已保存 ${time}`
          : `已保存 ${time}（首次保存，没有可备份的原文件）`,
        detail: result.backupPath ?? undefined,
        staleOnEdit: true
      })
      // 徽标跟着新结论走；草稿不动
      void refreshSnapshot()
    } catch (err) {
      setNotice({ kind: 'error', text: '保存失败，文件没有被改动', detail: errorText(err) })
    } finally {
      setBusy(false)
    }
  }, [dir, doc, entryId, refreshSnapshot])

  const createTemplate = useCallback(
    async (input: { id: string; name: string; styleTemplate?: string }): Promise<boolean> => {
      const api = templateApi()
      if (!api || !dir) return false
      setBusy(true)
      try {
        const payload = input.styleTemplate
          ? { dir, id: input.id, name: input.name, styleTemplate: input.styleTemplate }
          : { dir, id: input.id, name: input.name }
        const result = await api.create(payload)
        applyRead(result)
        setNotice({ kind: 'info', text: `已新建「${result.id}」` })
        void refreshSnapshot()
        return true
      } catch (err) {
        setNotice({ kind: 'error', text: '新建失败', detail: errorText(err) })
        return false
      } finally {
        setBusy(false)
      }
    },
    [applyRead, dir, refreshSnapshot]
  )

  const removeTemplate = useCallback(async (): Promise<boolean> => {
    const api = templateApi()
    if (!api || !dir || !entryId) return false
    setBusy(true)
    try {
      const result = await api.remove({ dir, id: entryId })
      const next = await api.snapshot()
      setSnapshot(next)
      setNotice({ kind: 'info', text: `已删除「${entryId}」`, detail: result.backupPath })
      const nextDirSnapshot = next.dirs.find((item) => item.dir === dir) ?? null
      const nextEntry = nextDirSnapshot?.structures[0] ?? null
      if (nextEntry) {
        setEntryId(nextEntry.id)
        await readEntry(api, dir, nextEntry)
      } else {
        setDoc(null)
        setFile(null)
        setEntryId(null)
        setServerIssues([])
        setDirty(false)
      }
      return true
    } catch (err) {
      setNotice({ kind: 'error', text: '删除失败', detail: errorText(err) })
      return false
    } finally {
      setBusy(false)
    }
  }, [dir, entryId, readEntry])

  const renameTemplate = useCallback(
    async (input: { newId: string; name: string }): Promise<boolean> => {
      const api = templateApi()
      if (!api || !dir || !entryId) return false
      setBusy(true)
      try {
        const idChanged = input.newId !== '' && input.newId !== entryId
        const result = await api.rename({
          dir,
          id: entryId,
          name: input.name,
          ...(idChanged ? { newId: input.newId } : {})
        })
        applyRead(result)
        setNotice({
          kind: 'info',
          text: idChanged ? `已改 id 与名称：${entryId} → ${result.id}` : '已改名',
          detail: result.backupPath ?? undefined
        })
        void refreshSnapshot()
        return true
      } catch (err) {
        setNotice({ kind: 'error', text: '改名失败', detail: errorText(err) })
        return false
      } finally {
        setBusy(false)
      }
    },
    [applyRead, dir, entryId, refreshSnapshot]
  )

  // ================= 节点与内容块 =================

  const selectNode = useCallback((path: NodePath): void => setSelectedPath(path), [])

  /** 从校验结论跳到那个节点：选中它，并把它的祖先一起展开（不然它在树上看不见） */
  const revealNode = useCallback((path: NodePath): void => {
    setSelectedPath(path)
    setExpanded((current) => {
      const next = new Set(current)
      for (let depth = 1; depth <= path.length; depth += 1) {
        next.add(pathKey(path.slice(0, depth)))
      }
      return next
    })
  }, [])

  const toggleExpand = useCallback((key: string): void => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const expandAll = useCallback((): void => setExpanded(expandableKeys(doc)), [doc])
  const collapseAll = useCallback((): void => setExpanded(new Set()), [])

  const patchSelectedNode = useCallback(
    (patch: TemplateObject): void => mutate((current) => patchNodeAt(current, selectedPath, patch)),
    [mutate, selectedPath]
  )

  /**
   * 树上的结构操作：都按**传进来的那个路径**办事，不看当前选中谁是——
   * 右键菜单点的必须是那一行。菜单里按不了的项目自己会写明原因。
   */
  const addChildAt = useCallback(
    (path: NodePath): void => {
      if (!doc) return
      const parent = nodeAt(doc, path)
      if (!parent) return
      const index = rawChildren(parent).length
      const level = headingLevel(parent) + 1
      // 新节点跟这一组走：父节点下是列表子标题就加列表子标题，否则加层级标题
      // （同一父节点下不许混，见 templateDoc 的 childKindFor）；
      // 层级标题一级给 chapter、更深给 section，与现有模板的写法一致
      const child =
        childKindFor(doc, path) === 'listSubTitle'
          ? createTemplateNode(level, 'subTitle')
          : createTemplateNode(level, level <= 1 ? 'chapter' : 'section')
      mutate((current) => insertChildAt(current, path, child))
      setExpanded((current) => new Set(current).add(pathKey(path)))
      setSelectedPath([...path, index])
    },
    [doc, mutate]
  )

  /** 加同级：类别跟着点的那一行走（同一父节点下不许混） */
  const addSiblingAt = useCallback(
    (path: NodePath): void => {
      if (!doc || path.length === 0) return
      const node = nodeAt(doc, path)
      if (!node) return
      const sibling =
        nodeKind(node) === 'listSubTitle'
          ? createTemplateNode(headingLevel(node), 'subTitle')
          : createTemplateNode(headingLevel(node), nodeType(node) || 'section')
      mutate((current) => insertSiblingAfter(current, path, sibling))
      const index = path[path.length - 1] ?? 0
      setSelectedPath([...path.slice(0, -1), index + 1])
    },
    [doc, mutate]
  )

  const moveNodeAt = useCallback(
    (path: NodePath, delta: -1 | 1): void => {
      if (path.length === 0) return
      mutate((current) => moveNodeIn(current, path, delta))
      const index = path[path.length - 1]
      if (index === undefined) return
      setSelectedPath([...path.slice(0, -1), index + delta])
    },
    [mutate]
  )

  /** 复制整棵子树：插在原节点后面，选中新那一份（作者接着改名字就行） */
  const duplicateNodeAt = useCallback(
    (path: NodePath): void => {
      if (!doc || path.length === 0) return
      if (!nodeAt(doc, path)) return
      mutate((current) => duplicateNodeAtInDoc(current, path))
      const index = path[path.length - 1] ?? 0
      setSelectedPath([...path.slice(0, -1), index + 1])
    },
    [doc, mutate]
  )

  const removeNodeAt = useCallback(
    (path: NodePath): void => {
      if (path.length === 0) return
      mutate((current) => removeNodeAtInDoc(current, path))
      setSelectedPath(path.slice(0, -1))
    },
    [mutate]
  )

  /** 一支的开合：收就整支收掉，开就整支展开（菜单里的「展开/折叠该分支」） */
  const toggleBranchAt = useCallback(
    (path: NodePath): void => {
      const keys = branchKeys(doc, path)
      if (keys.length === 0) return
      setExpanded((current) => {
        const next = new Set(current)
        const open = next.has(pathKey(path))
        for (const key of keys) {
          if (open) next.delete(key)
          else next.add(key)
        }
        return next
      })
    },
    [doc]
  )

  const patchBlock = useCallback(
    (index: number, patch: TemplateObject): void =>
      mutate((current) => patchBlockAt(current, selectedPath, index, patch)),
    [mutate, selectedPath]
  )

  /** 加一块：不带 index 就追加到末尾，带 index 就是"插到这一块之前" */
  const addBlock = useCallback(
    (type: string, index?: number): void =>
      mutate((current) => addBlockAt(current, selectedPath, createTemplateBlock(type), index)),
    [mutate, selectedPath]
  )

  /** 复制一块（连同内容与锁）插在它下面 */
  const duplicateBlock = useCallback(
    (index: number): void => mutate((current) => duplicateBlockAt(current, selectedPath, index)),
    [mutate, selectedPath]
  )

  const moveBlock = useCallback(
    (index: number, delta: -1 | 1): void =>
      mutate((current) => moveBlockIn(current, selectedPath, index, delta)),
    [mutate, selectedPath]
  )

  const removeBlock = useCallback(
    (index: number): void => mutate((current) => removeBlockAt(current, selectedPath, index)),
    [mutate, selectedPath]
  )

  const dismissNotice = useCallback((): void => setNotice(null), [])

  return {
    status,
    snapshot,
    dirSnapshot,
    dir,
    entry,
    doc,
    openKind,
    styleEntry,
    style,
    busy,
    dirty,
    issues: visibleIssues,
    issuesSource,
    notice,
    pending,
    selectedPath,
    selectedNode,
    expanded,
    reload,
    requestReload,
    requestDir,
    requestEntry,
    requestStyle,
    confirmPending,
    cancelPending,
    save,
    createTemplate,
    removeTemplate,
    renameTemplate,
    dismissNotice,
    selectNode,
    revealNode,
    toggleExpand,
    expandAll,
    collapseAll,
    patchSelectedNode,
    addChildAt,
    addSiblingAt,
    duplicateNodeAt,
    moveNodeAt,
    removeNodeAt,
    toggleBranchAt,
    patchBlock,
    addBlock,
    duplicateBlock,
    moveBlock,
    removeBlock
  }
}
