/**
 * 应用状态（renderer）：会话/选中/变更提交/保存。
 * 模型：main 权威树 + renderer NodeDto 镜像；所有变更先 IPC（校验）成功后再本地生效。
 * 块编辑器为纯受控组件：NodePage 统一调度「本地更新 + 防抖提交」，提交前先 flush。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { NodeDto, ProjectInfoDto } from '../../../shared/project'
import type { BlockTypeName, ContentBlock } from '@documentor/core/blocks'
import { createBlock } from '@documentor/core/blocks'
import {
  addBlock as addBlockOp,
  collectIds,
  findNode,
  insertNode,
  moveBlockIn,
  removeBlockAt,
  removeNode,
  updateBlock as updateBlockOp,
  updateNode
} from './treeUtils'

export interface ToastItem {
  kind: 'info' | 'error'
  text: string
}

export interface AppSession {
  info: ProjectInfoDto
  root: NodeDto
}

interface AppContextValue {
  session: AppSession | null
  selectedId: string | null
  busy: boolean
  toast: ToastItem | null
  showToast: (toast: ToastItem) => void
  openProjectByPath: (dprojPath: string) => Promise<boolean>
  createProject: (input: {
    workspaceDir: string
    name: string
    templateName: string
  }) => Promise<boolean>
  closeProject: () => Promise<void>
  saveProject: () => Promise<boolean>
  selectNode: (id: string | null) => void
  /** 变更（await IPC 后本地生效） */
  setNodeTitle: (nodeId: string, title: string) => Promise<void>
  setNodeDescription: (nodeId: string, description: string) => Promise<void>
  copyNode: (nodeId: string) => Promise<void>
  deleteNode: (nodeId: string) => Promise<void>
  addContentBlock: (nodeId: string, type: BlockTypeName) => Promise<void>
  removeContentBlock: (nodeId: string, index: number) => Promise<void>
  moveContentBlock: (nodeId: string, from: number, to: number) => Promise<void>
  updateContentBlock: (nodeId: string, index: number, block: ContentBlock) => Promise<void>
  /** NodePage 注册/注销其 flush（块编辑器挂起提交），保存/切换前调用 */
  registerFlushAll: (fn: () => void) => () => void
  flushAll: () => Promise<void>
  /** 全局弹层（设置/导出）——由 App 壳层统一渲染，避免挂在标题栏 drag 区域内 */
  settingsOpen: boolean
  exportOpen: boolean
  openSettings: () => void
  closeSettings: () => void
  openExport: () => void
  closeExport: () => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp must be used within AppProvider')
  return value
}

const UI_STATE_SELECTED_KEY = 'selected_node'

export function AppProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [session, setSession] = useState<AppSession | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<ToastItem | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const toastTimer = useRef<number | undefined>(undefined)
  const flushesRef = useRef(new Set<() => void>())

  const showToast = useCallback((item: ToastItem) => {
    setToast(item)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 3200)
  }, [])

  const flushAll = useCallback(async () => {
    for (const fn of [...flushesRef.current]) {
      try {
        fn()
      } catch (err) {
        console.error('[store] flush failed:', err)
      }
    }
  }, [])

  const registerFlushAll = useCallback((fn: () => void) => {
    flushesRef.current.add(fn)
    return () => {
      flushesRef.current.delete(fn)
    }
  }, [])

  /** 打开/新建后统一进入会话 */
  const enterSession = useCallback((result: { info: ProjectInfoDto; root: NodeDto }) => {
    setSession({ info: result.info, root: result.root })
  }, [])

  const openProjectByPath = useCallback(
    async (dprojPath: string): Promise<boolean> => {
      setBusy(true)
      try {
        const result = await window.documentor.project.open(dprojPath)
        enterSession(result)
        // 恢复上次选中节点
        const saved = await window.documentor.uiState.load(UI_STATE_SELECTED_KEY)
        const ids = collectIds(result.root)
        setSelectedId(saved && ids.includes(saved) ? saved : null)
        return true
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
        return false
      } finally {
        setBusy(false)
      }
    },
    [enterSession, showToast]
  )

  const createProject = useCallback(
    async (input: { workspaceDir: string; name: string; templateName: string }) => {
      setBusy(true)
      try {
        const result = await window.documentor.project.create(input)
        enterSession(result)
        setSelectedId(null)
        return true
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
        return false
      } finally {
        setBusy(false)
      }
    },
    [enterSession, showToast]
  )

  const closeProject = useCallback(async () => {
    await flushAll()
    try {
      await window.documentor.project.close()
    } finally {
      setSession(null)
      setSelectedId(null)
    }
  }, [flushAll])

  const saveProject = useCallback(async (): Promise<boolean> => {
    await flushAll()
    try {
      const result = await window.documentor.project.save()
      showToast({ kind: 'info', text: `已保存 ${result.savedAt.slice(11, 19)}` })
      return true
    } catch (err) {
      showToast({ kind: 'error', text: `保存失败：${err instanceof Error ? err.message : String(err)}` })
      return false
    }
  }, [flushAll, showToast])

  /** 切换选中：先 flush 挂起编辑，再记录 ui_state */
  const selectNode = useCallback(
    (id: string | null) => {
      void flushAll()
      setSelectedId(id)
      if (id && session) {
        void window.documentor.uiState.save(UI_STATE_SELECTED_KEY, id).catch(() => undefined)
      }
    },
    [flushAll, session]
  )

  const guardSession = (): AppSession => {
    if (!session) throw new Error('工程未打开')
    return session
  }

  const setNodeTitle = useCallback(
    async (nodeId: string, title: string) => {
      const s = guardSession()
      try {
        await window.documentor.tree.updateTitle({ nodeId, title })
        setSession({ ...s, root: updateNode(s.root, nodeId, { title }) })
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast]
  )

  const setNodeDescription = useCallback(
    async (nodeId: string, description: string) => {
      const s = guardSession()
      try {
        await window.documentor.tree.updateDescription({ nodeId, description })
        setSession({ ...s, root: updateNode(s.root, nodeId, { description }) })
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast]
  )

  const copyNode = useCallback(
    async (nodeId: string) => {
      const s = guardSession()
      try {
        const result = await window.documentor.tree.copy({ nodeId })
        const slot = findInsertSlot(s.root, nodeId)
        if (slot) {
          setSession({
            ...s,
            root: insertNode(s.root, slot.parentId, slot.index, result.node)
          })
        } else {
          setSession({ ...s, root: insertNode(s.root, result.node.id, 0, result.node) })
        }
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast]
  )

  const deleteNode = useCallback(
    async (nodeId: string) => {
      const s = guardSession()
      try {
        await window.documentor.tree.delete({ nodeId })
        const next = removeNode(s.root, nodeId)
        if (!next) return
        setSession({ ...s, root: next })
        setSelectedId((current) => (current === nodeId ? null : current))
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast]
  )

  const addContentBlock = useCallback(
    async (nodeId: string, type: BlockTypeName) => {
      const s = guardSession()
      try {
        await window.documentor.block.add({ nodeId, type })
        const block = createBlock(type)
        setSession({ ...s, root: addBlockOp(s.root, nodeId, block) })
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast]
  )

  const removeContentBlock = useCallback(
    async (nodeId: string, index: number) => {
      const s = guardSession()
      try {
        await window.documentor.block.remove({ nodeId, index })
        setSession({ ...s, root: removeBlockAt(s.root, nodeId, index) })
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast]
  )

  const moveContentBlock = useCallback(
    async (nodeId: string, from: number, to: number) => {
      const s = guardSession()
      if (from === to) return
      try {
        await window.documentor.block.move({ nodeId, from, to })
        setSession({ ...s, root: moveBlockIn(s.root, nodeId, from, to) })
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast]
  )

  const updateContentBlock = useCallback(
    async (nodeId: string, index: number, block: ContentBlock) => {
      const s = guardSession()
      try {
        await window.documentor.block.update({ nodeId, index, block })
        setSession({ ...s, root: updateBlockOp(s.root, nodeId, index, block) })
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast]
  )

  // Ctrl+S 全局保存
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveProject()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveProject])

  const value = useMemo<AppContextValue>(
    () => ({
      session,
      selectedId,
      busy,
      toast,
      showToast,
      openProjectByPath,
      createProject,
      closeProject,
      saveProject,
      selectNode,
      setNodeTitle,
      setNodeDescription,
      copyNode,
      deleteNode,
      addContentBlock,
      removeContentBlock,
      moveContentBlock,
      updateContentBlock,
      registerFlushAll,
      flushAll,
      settingsOpen,
      exportOpen,
      openSettings: () => setSettingsOpen(true),
      closeSettings: () => setSettingsOpen(false),
      openExport: () => setExportOpen(true),
      closeExport: () => setExportOpen(false)
    }),
    [
      session,
      selectedId,
      busy,
      toast,
      showToast,
      openProjectByPath,
      createProject,
      closeProject,
      saveProject,
      selectNode,
      setNodeTitle,
      setNodeDescription,
      copyNode,
      deleteNode,
      addContentBlock,
      removeContentBlock,
      moveContentBlock,
      updateContentBlock,
      registerFlushAll,
      flushAll,
      settingsOpen,
      exportOpen
    ]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

/** 复制节点插入槽位：源节点之后 */
function findInsertSlot(root: NodeDto, nodeId: string): { parentId: string; index: number } | null {
  const walk = (node: NodeDto): { parentId: string; index: number } | null => {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i]!
      if (child.id === nodeId) return { parentId: node.id, index: i + 1 }
      const hit = walk(child)
      if (hit) return hit
    }
    return null
  }
  return walk(root)
}

/** 供树面板/节点页判断当前节点 */
export function useSelectedNode(): NodeDto | null {
  const { session, selectedId } = useApp()
  return session && selectedId ? findNode(session.root, selectedId) : null
}
