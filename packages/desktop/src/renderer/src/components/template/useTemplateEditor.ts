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
  TemplateSaveResult
} from '../../../../shared/project'
import {
  ROOT_PATH,
  addBlockAt,
  createTemplateBlock,
  createTemplateNode,
  expandableKeys,
  headingLevel,
  insertChildAt,
  insertSiblingAfter,
  moveBlockIn,
  moveNodeIn,
  nodeAt,
  nodeType,
  nodeTypeOptions,
  pathKey,
  patchBlockAt,
  patchNodeAt,
  rawChildren,
  removeBlockAt,
  removeNodeAt,
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
}

/** 有未保存改动时切换对象（模板/目录）或重新加载，要先问一句，避免草稿被静默丢掉 */
export type TemplatePending =
  | { kind: 'entry'; entry: TemplateEntryDto }
  | { kind: 'dir'; dir: string }
  | { kind: 'reload' }

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
  busy: boolean
  dirty: boolean
  issues: TemplateIssueDto[]
  issuesSource: TemplateIssuesSource
  notice: TemplateNotice | null
  saveResult: TemplateSaveResult | null
  pending: TemplatePending | null
  selectedPath: NodePath
  selectedNode: TemplateObject | null
  expanded: Set<string>
  nodeTypes: string[]
  reload: () => Promise<void>
  requestReload: () => void
  requestDir: (dir: string) => void
  requestEntry: (entry: TemplateEntryDto) => void
  confirmPending: () => void
  cancelPending: () => void
  save: () => Promise<void>
  createTemplate: (input: { id: string; name: string; styleTemplate?: string }) => Promise<boolean>
  removeTemplate: () => Promise<boolean>
  renameTemplate: (input: { newId: string; name: string }) => Promise<boolean>
  dismissNotice: () => void
  selectNode: (path: NodePath) => void
  toggleExpand: (key: string) => void
  expandAll: () => void
  collapseAll: () => void
  patchSelectedNode: (patch: TemplateObject) => void
  addChildNode: () => void
  addSiblingNode: () => void
  moveSelectedNode: (delta: -1 | 1) => void
  canMoveSelected: { up: boolean; down: boolean }
  removeSelectedNode: () => void
  patchBlock: (index: number, patch: TemplateObject) => void
  addBlock: (type: string) => void
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
  const [saveResult, setSaveResult] = useState<TemplateSaveResult | null>(null)
  const [pending, setPending] = useState<TemplatePending | null>(null)
  const [selectedPath, setSelectedPath] = useState<NodePath>(ROOT_PATH)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

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

  /** 打开一份读回来的结果：草稿、选中、展开、问题列表一起归位 */
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
    setSaveResult(null)
    setPending(null)
  }, [])

  const readEntry = useCallback(
    async (api: EditorApi, targetDir: string, target: TemplateEntryDto): Promise<void> => {
      setBusy(true)
      try {
        applyRead(await api.read({ dir: targetDir, id: target.id }))
      } catch (err) {
        setNotice({ kind: 'error', text: '读不到这份模板', detail: errorText(err) })
      } finally {
        setBusy(false)
      }
    },
    [applyRead]
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

  const requestEntry = useCallback(
    (target: TemplateEntryDto): void => {
      if (target.id === entryId) return
      if (dirty) {
        setPending({ kind: 'entry', entry: target })
        return
      }
      const api = templateApi()
      if (!api || !dir) return
      setEntryId(target.id)
      void readEntry(api, dir, target)
    },
    [dir, dirty, entryId, readEntry]
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
    setEntryId(action.entry.id)
    void readEntry(api, dir, action.entry)
  }, [dir, pending, readEntry, reload, switchDir])

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
      setSaveResult(null)
    },
    [doc]
  )

  const save = useCallback(async (): Promise<void> => {
    const api = templateApi()
    if (!api || !doc || !dir || !entryId) return
    setBusy(true)
    try {
      const result = await api.save({ dir, id: entryId, doc })
      setSaveResult(result)
      setServerIssues(result.issues)
      setIssuesSource('server')
      setDirty(false)
      setNotice({ kind: 'info', text: `已保存 ${result.savedAt.slice(11, 19)}` })
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

  const addChildNode = useCallback((): void => {
    if (!doc) return
    const parent = nodeAt(doc, selectedPath)
    if (!parent) return
    const index = rawChildren(parent).length
    const level = headingLevel(parent) + 1
    // 一级给 chapter、更深给 section：与现有模板的写法一致（nodeType 只在 subTitle 上有语义）
    const child = createTemplateNode(level, level <= 1 ? 'chapter' : 'section')
    mutate((current) => insertChildAt(current, selectedPath, child))
    setExpanded((current) => new Set(current).add(pathKey(selectedPath)))
    setSelectedPath([...selectedPath, index])
  }, [doc, mutate, selectedPath])

  const addSiblingNode = useCallback((): void => {
    if (!doc || selectedPath.length === 0) return
    const node = nodeAt(doc, selectedPath)
    if (!node) return
    const sibling = createTemplateNode(headingLevel(node), nodeType(node) || 'section')
    mutate((current) => insertSiblingAfter(current, selectedPath, sibling))
    const index = selectedPath[selectedPath.length - 1] ?? 0
    setSelectedPath([...selectedPath.slice(0, -1), index + 1])
  }, [doc, mutate, selectedPath])

  const moveSelectedNode = useCallback(
    (delta: -1 | 1): void => {
      mutate((current) => moveNodeIn(current, selectedPath, delta))
      const index = selectedPath[selectedPath.length - 1]
      if (index === undefined) return
      setSelectedPath([...selectedPath.slice(0, -1), index + delta])
    },
    [mutate, selectedPath]
  )

  const canMoveSelected = useMemo(() => {
    if (!doc || selectedPath.length === 0) return { up: false, down: false }
    const parentPath = selectedPath.slice(0, -1)
    const index = selectedPath[selectedPath.length - 1] ?? 0
    const parent = nodeAt(doc, parentPath)
    if (!parent) return { up: false, down: false }
    const count = rawChildren(parent).length
    return { up: index > 0, down: index < count - 1 }
  }, [doc, selectedPath])

  const removeSelectedNode = useCallback((): void => {
    if (selectedPath.length === 0) return
    mutate((current) => removeNodeAt(current, selectedPath))
    setSelectedPath(selectedPath.slice(0, -1))
  }, [mutate, selectedPath])

  const patchBlock = useCallback(
    (index: number, patch: TemplateObject): void =>
      mutate((current) => patchBlockAt(current, selectedPath, index, patch)),
    [mutate, selectedPath]
  )

  const addBlock = useCallback(
    (type: string): void =>
      mutate((current) => addBlockAt(current, selectedPath, createTemplateBlock(type))),
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

  const nodeTypes = useMemo(
    () => nodeTypeOptions(doc, selectedNode ? nodeType(selectedNode) : ''),
    [doc, selectedNode]
  )

  return {
    status,
    snapshot,
    dirSnapshot,
    dir,
    entry,
    doc,
    busy,
    dirty,
    issues,
    issuesSource,
    notice,
    saveResult,
    pending,
    selectedPath,
    selectedNode,
    expanded,
    nodeTypes,
    reload,
    requestReload,
    requestDir,
    requestEntry,
    confirmPending,
    cancelPending,
    save,
    createTemplate,
    removeTemplate,
    renameTemplate,
    dismissNotice,
    selectNode,
    toggleExpand,
    expandAll,
    collapseAll,
    patchSelectedNode,
    addChildNode,
    addSiblingNode,
    moveSelectedNode,
    canMoveSelected,
    removeSelectedNode,
    patchBlock,
    addBlock,
    moveBlock,
    removeBlock
  }
}
