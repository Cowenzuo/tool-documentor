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
  /** info=中性成功提示；warn=成功但有需注意之处；error=失败 */
  kind: 'info' | 'warn' | 'error'
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
  closeProject: () => Promise<boolean>
  saveProject: () => Promise<boolean>
  selectNode: (id: string | null) => void
  /** 变更（await IPC 后本地生效） */
  setNodeTitle: (nodeId: string, title: string) => Promise<void>
  setNodeDescription: (nodeId: string, description: string) => Promise<void>
  copyNode: (nodeId: string) => Promise<void>
  deleteNode: (nodeId: string) => Promise<void>
  addContentBlock: (nodeId: string, type: BlockTypeName, index?: number) => Promise<void>
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
        // 打开的工程若有内容块被跳过，必须让用户知道：下一次保存就再也找不回来了
        if (result.warnings && result.warnings.length > 0) {
          showToast({ kind: 'warn', text: result.warnings.join('；') })
        }
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

  /** 关闭工程：保存失败就留在工程里，别让用户以为已经安全退出 */
  const closeProject = useCallback(async (): Promise<boolean> => {
    await flushAll()
    try {
      await window.documentor.project.close()
    } catch (err) {
      showToast({
        kind: 'error',
        text: `保存失败，未关闭工程：${err instanceof Error ? err.message : String(err)}`
      })
      return false
    }
    setSession(null)
    setSelectedId(null)
    return true
  }, [flushAll, showToast])

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

  const guardSession = (): void => {
    if (!session) throw new Error('工程未打开')
  }

  /**
   * 改根树的唯一入口。必须用函数式更新：这些写操作都在 await 之后才回写状态，
   * 拿 await 之前的会话快照回写会在重叠提交时互相覆盖（后完成的那次把前一次的改动抹掉，
   * 界面回退成旧值，再保存就把旧值写回库）。op 返回 null 表示无需变化。
   */
  const updateRoot = useCallback((op: (root: NodeDto) => NodeDto | null) => {
    setSession((current) => {
      if (!current) return current
      const next = op(current.root)
      return next ? { ...current, root: next } : current
    })
  }, [])

  const setNodeTitle = useCallback(
    async (nodeId: string, title: string) => {
      guardSession()
      try {
        await window.documentor.tree.updateTitle({ nodeId, title })
        updateRoot((root) => updateNode(root, nodeId, { title }))
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast, updateRoot]
  )

  const setNodeDescription = useCallback(
    async (nodeId: string, description: string) => {
      guardSession()
      try {
        await window.documentor.tree.updateDescription({ nodeId, description })
        updateRoot((root) => updateNode(root, nodeId, { description }))
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast, updateRoot]
  )

  const copyNode = useCallback(
    async (nodeId: string) => {
      guardSession()
      try {
        const result = await window.documentor.tree.copy({ nodeId })
        updateRoot((root) => {
          const slot = findInsertSlot(root, nodeId)
          return slot
            ? insertNode(root, slot.parentId, slot.index, result.node)
            : insertNode(root, result.node.id, 0, result.node)
        })
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast, updateRoot]
  )

  const deleteNode = useCallback(
    async (nodeId: string) => {
      guardSession()
      try {
        await window.documentor.tree.delete({ nodeId })
        updateRoot((root) => removeNode(root, nodeId))
        setSelectedId((current) => (current === nodeId ? null : current))
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast, updateRoot]
  )

  const addContentBlock = useCallback(
    async (nodeId: string, type: BlockTypeName, index?: number) => {
      guardSession()
      try {
        await window.documentor.block.add({ nodeId, type, ...(typeof index === 'number' ? { index } : {}) })
        const block = createBlock(type)
        updateRoot((root) => addBlockOp(root, nodeId, block, index))
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast, updateRoot]
  )

  const removeContentBlock = useCallback(
    async (nodeId: string, index: number) => {
      guardSession()
      try {
        await window.documentor.block.remove({ nodeId, index })
        updateRoot((root) => removeBlockAt(root, nodeId, index))
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast, updateRoot]
  )

  const moveContentBlock = useCallback(
    async (nodeId: string, from: number, to: number) => {
      guardSession()
      if (from === to) return
      try {
        await window.documentor.block.move({ nodeId, from, to })
        updateRoot((root) => moveBlockIn(root, nodeId, from, to))
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast, updateRoot]
  )

  const updateContentBlock = useCallback(
    async (nodeId: string, index: number, block: ContentBlock) => {
      guardSession()
      try {
        await window.documentor.block.update({ nodeId, index, block })
        updateRoot((root) => updateBlockOp(root, nodeId, index, block))
      } catch (err) {
        showToast({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, showToast, updateRoot]
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
