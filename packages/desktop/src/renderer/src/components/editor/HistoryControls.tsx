/**
 * 撤销/重做与历史列表：放在「编辑 / 预览」那一行的左侧。
 *
 * 面板按 Word 的读法列历史：列出来的每一条就是一步动作，点它即退到这一步之前，
 * 所以点最旧的那条就是回到最初，不需要另立一行；已撤销段的每一条点下去即重做到那一步。
 * 当前状态本身不列：它不是一个动作，点了也等于什么都没发生。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '../../state/AppContext'

/** 面板里的一步：keep 的含义见 AppContext.jumpHistory（保留多少步已应用的编辑） */
interface HistoryRow {
  label: string
  keep: number
}

export function HistoryControls(): React.JSX.Element {
  const { undo, redo, jumpHistory, historyState } = useApp()
  const [open, setOpen] = useState(false)
  const barRef = useRef<HTMLDivElement | null>(null)
  const caretRef = useRef<HTMLButtonElement | null>(null)

  const applied = historyState.undoLabels
  const undone = historyState.redoLabels

  /** 关面板并把焦点还给开关：点完一条把焦点丢到 body 上，键盘用户就得从头 Tab */
  const closeToCaret = useCallback(() => {
    setOpen(false)
    caretRef.current?.focus()
  }, [])

  /**
   * 点外部或按 Esc 关闭。只在焦点本来就在面板里时才收回开关，
   * 别的地方按 Esc 不该把焦点从用户手上拽走。
   */
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      if (!barRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (barRef.current?.contains(document.activeElement)) closeToCaret()
      else setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [closeToCaret, open])

  /** 点一条：先收起面板（动作已经在路上），再让 store 跳到那一步 */
  const pick = useCallback(
    (keep: number) => {
      closeToCaret()
      void jumpHistory(keep)
    },
    [closeToCaret, jumpHistory]
  )

  // 已应用段：最近的排最上面；每条 keep 取它在时间顺序里的下标，
  // 点第 k 条就是"退到第 k 步之前"，最旧那条自然等于回到最初
  const appliedRows: HistoryRow[] = applied
    .map((label, index) => ({ label, keep: index }))
    .reverse()

  // 已撤销段：下一个能重做的排最上面，点它就等于重做到这一步
  const undoneRows: HistoryRow[] = undone.map((label, j) => ({
    label,
    keep: applied.length + j + 1
  }))

  return (
    <div className="hist-bar" ref={barRef}>
      <button
        type="button"
        className="hist-btn"
        disabled={!historyState.canUndo}
        title={historyState.undoLabel ? `撤销：${historyState.undoLabel}` : '撤销'}
        onClick={() => void undo()}
      >
        撤销
      </button>
      <button
        type="button"
        className="hist-btn"
        disabled={!historyState.canRedo}
        title={historyState.redoLabel ? `重做：${historyState.redoLabel}` : '重做'}
        onClick={() => void redo()}
      >
        重做
      </button>
      <button
        type="button"
        className="hist-caret"
        ref={caretRef}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        历史 <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="hist-panel">
          {applied.length === 0 && undone.length === 0 ? (
            <p className="hist-empty">还没有可撤销的编辑</p>
          ) : (
            <>
              {applied.length > 0 && (
                <div className="hist-section">
                  <div className="hist-section-title">已应用</div>
                  {appliedRows.map((row) => (
                    <button
                      key={row.keep}
                      type="button"
                      className="hist-item"
                      data-keep={row.keep}
                      onClick={() => pick(row.keep)}
                    >
                      {row.label}
                    </button>
                  ))}
                </div>
              )}
              {undone.length > 0 && (
                <div className="hist-section">
                  <div className="hist-section-title">已撤销</div>
                  {undoneRows.map((row) => (
                    <button
                      key={row.keep}
                      type="button"
                      className="hist-item"
                      data-keep={row.keep}
                      onClick={() => pick(row.keep)}
                    >
                      {row.label}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
