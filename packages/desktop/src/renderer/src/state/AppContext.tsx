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
import type {
  HistoryResultDto,
  HistoryStateDto,
  NodeDto,
  ProjectInfoDto
} from '../../../shared/project'
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
    templateUuid: string
  }) => Promise<boolean>
  closeProject: () => Promise<boolean>
  saveProject: () => Promise<boolean>
  /** 撤销/重做：先冲刷挂起的编辑，成功后整棵替换会话 */
  undo: () => Promise<void>
  redo: () => Promise<void>
  /** 跳到历史里的某一步：keep = 保留多少步已应用的编辑，0 表示回到最初 */
  jumpHistory: (keep: number) => Promise<void>
  /** 历史栈状态：驱动按钮置灰、悬停提示与历史列表 */
  historyState: HistoryStateDto
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
  /**
   * 模板编辑页（PLAN-11 批次 2）：整页独立于文档会话——不打开工程、不进撤销栈，
   * 页面自己的状态在 useTemplateEditor 里，这里只管它在不在最前面。
   */
  templateEditorOpen: boolean
  openTemplateEditor: () => void
  closeTemplateEditor: () => void
}

const AppContext = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const value = useContext(AppContext)
  if (!value) throw new Error('useApp must be used within AppProvider')
  return value
}

const UI_STATE_SELECTED_KEY = 'selected_node'

/** 没有会话时的历史栈状态：按钮全灰、无提示动作名 */
const EMPTY_HISTORY: HistoryStateDto = {
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  steps: 0,
  undoLabels: [],
  redoLabels: []
}

export function AppProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [session, setSession] = useState<AppSession | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<ToastItem | null>(null)
  const [historyState, setHistoryState] = useState<HistoryStateDto>(EMPTY_HISTORY)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [templateEditorOpen, setTemplateEditorOpen] = useState(false)
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

  /**
   * 拉一次历史栈状态（按钮置灰与悬停提示用）。
   * 静默失败：它只影响按钮是否可点，拿不到就维持现状，不打断编辑也不弹提示。
   */
  const refreshHistory = useCallback((): void => {
    try {
      void window.documentor.history
        .state()
        .then(setHistoryState)
        .catch(() => undefined)
    } catch {
      /* 忽略：拿不到历史状态就维持现状 */
    }
  }, [])

  /** 打开/新建后统一进入会话 */
  const enterSession = useCallback(
    (result: { info: ProjectInfoDto; root: NodeDto }) => {
      setSession({ info: result.info, root: result.root })
      // 打开与新建都会清栈，进来顺手拉一次，按钮不会拿着上一个工程的状态
      refreshHistory()
    },
    [refreshHistory]
  )

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
        showToast({ kind: 'error', text: '操作失败' })
        return false
      } finally {
        setBusy(false)
      }
    },
    [enterSession, showToast]
  )

  const createProject = useCallback(
    async (input: { workspaceDir: string; name: string; templateUuid: string }) => {
      setBusy(true)
      try {
        const result = await window.documentor.project.create(input)
        enterSession(result)
        setSelectedId(null)
        return true
      } catch (err) {
        showToast({ kind: 'error', text: '操作失败' })
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
        text: '保存失败，未关闭工程'
      })
      return false
    }
    setSession(null)
    setSelectedId(null)
    // 历史不跨工程：关了就把栈的状态清干净
    setHistoryState(EMPTY_HISTORY)
    return true
  }, [flushAll, showToast])

  const saveProject = useCallback(async (): Promise<boolean> => {
    await flushAll()
    try {
      const result = await window.documentor.project.save()
      showToast({ kind: 'info', text: `已保存 ${result.savedAt.slice(11, 19)}` })
      return true
    } catch (err) {
      showToast({ kind: 'error', text: '保存失败' })
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
        refreshHistory()
      } catch (err) {
        showToast({ kind: 'error', text: '操作失败' })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshHistory, session, showToast, updateRoot]
  )

  const setNodeDescription = useCallback(
    async (nodeId: string, description: string) => {
      guardSession()
      try {
        await window.documentor.tree.updateDescription({ nodeId, description })
        updateRoot((root) => updateNode(root, nodeId, { description }))
        refreshHistory()
      } catch (err) {
        showToast({ kind: 'error', text: '操作失败' })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshHistory, session, showToast, updateRoot]
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
        refreshHistory()
      } catch (err) {
        showToast({ kind: 'error', text: '操作失败' })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshHistory, session, showToast, updateRoot]
  )

  const deleteNode = useCallback(
    async (nodeId: string) => {
      guardSession()
      try {
        await window.documentor.tree.delete({ nodeId })
        updateRoot((root) => removeNode(root, nodeId))
        setSelectedId((current) => (current === nodeId ? null : current))
        refreshHistory()
      } catch (err) {
        showToast({ kind: 'error', text: '操作失败' })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshHistory, session, showToast, updateRoot]
  )

  const addContentBlock = useCallback(
    async (nodeId: string, type: BlockTypeName, index?: number) => {
      guardSession()
      try {
        await window.documentor.block.add({ nodeId, type, ...(typeof index === 'number' ? { index } : {}) })
        const block = createBlock(type)
        updateRoot((root) => addBlockOp(root, nodeId, block, index))
        refreshHistory()
      } catch (err) {
        showToast({ kind: 'error', text: '操作失败' })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshHistory, session, showToast, updateRoot]
  )

  const removeContentBlock = useCallback(
    async (nodeId: string, index: number) => {
      guardSession()
      try {
        await window.documentor.block.remove({ nodeId, index })
        updateRoot((root) => removeBlockAt(root, nodeId, index))
        refreshHistory()
      } catch (err) {
        showToast({ kind: 'error', text: '操作失败' })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshHistory, session, showToast, updateRoot]
  )

  const moveContentBlock = useCallback(
    async (nodeId: string, from: number, to: number) => {
      guardSession()
      if (from === to) return
      try {
        await window.documentor.block.move({ nodeId, from, to })
        updateRoot((root) => moveBlockIn(root, nodeId, from, to))
        refreshHistory()
      } catch (err) {
        showToast({ kind: 'error', text: '操作失败' })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshHistory, session, showToast, updateRoot]
  )

  const updateContentBlock = useCallback(
    async (nodeId: string, index: number, block: ContentBlock) => {
      guardSession()
      try {
        await window.documentor.block.update({ nodeId, index, block })
        updateRoot((root) => updateBlockOp(root, nodeId, index, block))
        refreshHistory()
      } catch (err) {
        showToast({ kind: 'error', text: '操作失败' })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refreshHistory, session, showToast, updateRoot]
  )

  /**
   * 撤销/重做共用：返回载荷与打开工程同形状，界面整棵替换。
   * 选中项在新树里没了（例如撤掉“加章节”），就退到这一步动的章节，再不行退回根。
   */
  const applyHistoryResult = useCallback(
    (result: HistoryResultDto) => {
      setSession((current) => (current ? { info: result.info, root: result.root } : current))
      setHistoryState(result.history)
      if (result.warnings && result.warnings.length > 0) {
        showToast({ kind: 'warn', text: result.warnings.join('；') })
      }
      setSelectedId((current) => {
        if (current && hasNodeId(result.root, current)) return current
        if (result.focusNodeId && hasNodeId(result.root, result.focusNodeId)) {
          return result.focusNodeId
        }
        return result.root.id
      })
    },
    [showToast]
  )

  /**
   * 撤销与重做都问主进程要结果，不拿界面缓存的 canUndo 当门闸：
   * 缓存可能因为刷新竞态或外部写入（探针、脚本直接调 IPC）落后，
   * 那时按了没反应比多打一次 IPC 更糟。空栈的拒绝在这里吞掉，不弹提示。
   */
  const runHistory = useCallback(
    async (run: () => Promise<HistoryResultDto>): Promise<void> => {
      if (!session) return
      // 栈上顺序要与用户看到的顺序一致：先把防抖缓冲里的编辑落定
      await flushAll()
      try {
        applyHistoryResult(await run())
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('没有可撤销') || message.includes('没有可重做')) return
        showToast({ kind: 'error', text: message })
      }
    },
    [applyHistoryResult, flushAll, session, showToast]
  )

  const undo = useCallback(async (): Promise<void> => {
    await runHistory(() => window.documentor.history.undo())
  }, [runHistory])

  const redo = useCallback(async (): Promise<void> => {
    await runHistory(() => window.documentor.history.redo())
  }, [runHistory])

  const jumpHistory = useCallback(
    async (keep: number): Promise<void> => {
      await runHistory(() => window.documentor.history.jump({ keep }))
    },
    [runHistory]
  )

  // Ctrl+S 全局保存（模板编辑页打开时让位：那页保存的是模板文件，不是工程）
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (templateEditorOpen) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveProject()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [saveProject, templateEditorOpen])

  /**
   * Ctrl+Z 撤销，Ctrl+Shift+Z / Ctrl+Y 重做。
   * 捕获阶段拦下：文本框里按 Ctrl+Z 也走应用级撤销，不让浏览器自己改文字——
   * 界面与内存里的树一旦分叉，保存下去就是脏数据。弹层打开时不动键盘，
   * 免得把弹层里输入框的撤销也吃掉。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      if (event.altKey) return
      const key = event.key.toLowerCase()
      const isUndo = key === 'z' && !event.shiftKey
      const isRedo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)
      if (!isUndo && !isRedo) return
      if (!session || settingsOpen || exportOpen || templateEditorOpen) return
      event.preventDefault()
      void (isUndo ? undo() : redo())
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [exportOpen, redo, session, settingsOpen, templateEditorOpen, undo])

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
      undo,
      redo,
      jumpHistory,
      historyState,
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
      closeExport: () => setExportOpen(false),
      templateEditorOpen,
      openTemplateEditor: () => setTemplateEditorOpen(true),
      closeTemplateEditor: () => setTemplateEditorOpen(false)
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
      undo,
      redo,
      jumpHistory,
      historyState,
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
      templateEditorOpen
    ]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

/** 撤销/重做后恢复选中：沿树递归查这个 id 还在不在 */
function hasNodeId(root: NodeDto, id: string): boolean {
  if (root.id === id) return true
  return root.children.some((child) => hasNodeId(child, id))
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
