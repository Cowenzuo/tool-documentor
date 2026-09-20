/**
 * 撤销栈：只认"改动前 / 改动后"两份快照，不认具体是什么操作。
 *
 * 为什么不做反向指令：内容块没有稳定 id，按下标记反向会在插入删除之后错位；
 * 快照只认对象本身，谁改的就存谁的子树，撤销写回前一份、重做写回后一份。
 *
 * 合并规则：同一合并键、且在合并窗口内的连续编辑并成一步（保留最早的 before）；
 * 换对象、超窗口、显式 seal 都封口。保存时调用方 seal，免得撤销跨过一次保存。
 */

export interface HistoryPushInput<S> {
  /** 界面提示用的动作名，例如"删除内容""修改标题" */
  label: string
  before: S
  after: S
  /** 同一对象同一字段的合并键；不传或 null 表示这一步不与任何步骤合并 */
  coalesceKey?: string | null
  /** 覆盖默认的合并窗口 */
  coalesceWindowMs?: number
}

export interface HistoryEntry<S> {
  label: string
  before: S
  after: S
  coalesceKey: string | null
  /** 入栈时间（毫秒），合并时刷新 */
  at: number
}

export interface HistoryState {
  canUndo: boolean
  canRedo: boolean
  /** 最近一步可撤销动作的名字，栈空为 null */
  undoLabel: string | null
  redoLabel: string | null
  steps: number
  bytes: number
}

export interface HistoryStackOptions<S> {
  maxSteps?: number
  maxBytes?: number
  /** 量一条记录占多少字节，缺省不计量（上限只看步数） */
  measure?: (snapshot: S) => number
  now?: () => number
}

/** 默认合并窗口与默认上限：与编辑器 600 毫秒的防抖一致 */
export const HISTORY_COALESCE_MS = 600
export const HISTORY_MAX_STEPS = 100
export const HISTORY_MAX_BYTES = 32 * 1024 * 1024

export class HistoryStack<S> {
  private undoStack: HistoryEntry<S>[] = []
  private redoStack: HistoryEntry<S>[] = []
  private lastPushAt = 0
  private lastCoalesceKey: string | null = null
  private readonly maxSteps: number
  private readonly maxBytes: number
  private readonly measure: (snapshot: S) => number
  private readonly now: () => number

  constructor(options: HistoryStackOptions<S> = {}) {
    this.maxSteps = options.maxSteps ?? HISTORY_MAX_STEPS
    this.maxBytes = options.maxBytes ?? HISTORY_MAX_BYTES
    this.measure = options.measure ?? (() => 0)
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 记一步。返回 true 表示与上一步合并了。
   * 任何新步骤都会清空重做栈，这是撤销的常规口径。
   */
  push(input: HistoryPushInput<S>): boolean {
    const at = this.now()
    const key = input.coalesceKey ?? null
    const window = input.coalesceWindowMs ?? HISTORY_COALESCE_MS
    const top = this.undoStack[this.undoStack.length - 1]
    const mergeable =
      top !== undefined &&
      key !== null &&
      this.lastCoalesceKey === key &&
      at - this.lastPushAt <= window

    if (mergeable && top) {
      top.after = input.after
      top.at = at
    } else {
      this.undoStack.push({ label: input.label, before: input.before, after: input.after, coalesceKey: key, at })
    }
    this.lastPushAt = at
    this.lastCoalesceKey = key
    this.redoStack = []
    this.evict()
    return mergeable
  }

  /** 封口：下一次 push 一律开新的一步 */
  seal(): void {
    this.lastCoalesceKey = null
    this.lastPushAt = 0
  }

  /** 取走最近一步待撤销的记录；调用方拿 before 写回 */
  undo(): HistoryEntry<S> | null {
    const entry = this.undoStack.pop()
    if (!entry) return null
    this.redoStack.push(entry)
    this.seal()
    return entry
  }

  /** 取走最近一步待重做的记录；调用方拿 after 写回 */
  redo(): HistoryEntry<S> | null {
    const entry = this.redoStack.pop()
    if (!entry) return null
    this.undoStack.push(entry)
    this.seal()
    return entry
  }

  state(): HistoryState {
    const undoTop = this.undoStack[this.undoStack.length - 1]
    const redoTop = this.redoStack[this.redoStack.length - 1]
    return {
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      undoLabel: undoTop ? undoTop.label : null,
      redoLabel: redoTop ? redoTop.label : null,
      steps: this.undoStack.length,
      bytes: this.bytes()
    }
  }

  /** 已应用的步骤名，旧到新；界面按倒序显示，最近一步在最上面 */
  undoLabels(): string[] {
    return this.undoStack.map((entry) => entry.label)
  }

  /** 已撤销的步骤名，下一个要重做的排在最前 */
  redoLabels(): string[] {
    const labels: string[] = []
    for (let i = this.redoStack.length - 1; i >= 0; i -= 1) labels.push(this.redoStack[i]!.label)
    return labels
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
    this.seal()
  }

  private bytes(): number {
    let total = 0
    for (const entry of this.undoStack) total += this.measure(entry.before) + this.measure(entry.after)
    for (const entry of this.redoStack) total += this.measure(entry.before) + this.measure(entry.after)
    return total
  }

  /** 超上限从最旧开始丢；至少留一条，保证最后一步总能撤销 */
  private evict(): void {
    while (this.undoStack.length > this.maxSteps) this.undoStack.shift()
    if (this.maxBytes <= 0) return
    while (this.undoStack.length > 1 && this.bytes() > this.maxBytes) this.undoStack.shift()
  }
}
