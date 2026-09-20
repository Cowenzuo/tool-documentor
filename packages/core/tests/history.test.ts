/**
 * history.test.ts — 撤销栈的单测：合并窗口、封口、上限淘汰、重做失效。
 * 栈只认快照，字符串就够当快照样本。
 */

import { describe, expect, it } from 'vitest'
import { HistoryStack } from '../src/history'

/** 可控时钟：测合并窗口不靠真实时间 */
function fakeClock(start = 1000): { now: () => number; tick: (ms: number) => void } {
  let value = start
  return { now: () => value, tick: (ms) => (value += ms) }
}

describe('HistoryStack 基本撤销与重做', () => {
  it('记一步、撤销拿 before、重做拿 after', () => {
    const stack = new HistoryStack<string>()
    stack.push({ label: '修改内容', before: 'A', after: 'B' })
    expect(stack.state()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: '修改内容', steps: 1 })

    const undone = stack.undo()
    expect(undone?.before).toBe('A')
    expect(stack.state()).toMatchObject({ canUndo: false, canRedo: true, redoLabel: '修改内容' })

    const redone = stack.redo()
    expect(redone?.after).toBe('B')
    expect(stack.state()).toMatchObject({ canUndo: true, canRedo: false })
  })

  it('栈空时撤销与重做都返回 null', () => {
    const stack = new HistoryStack<string>()
    expect(stack.undo()).toBeNull()
    expect(stack.redo()).toBeNull()
  })

  it('新编辑清空重做栈', () => {
    const stack = new HistoryStack<string>()
    stack.push({ label: '第一步', before: 'A', after: 'B' })
    stack.undo()
    expect(stack.state().canRedo).toBe(true)
    stack.push({ label: '新的编辑', before: 'A', after: 'C' })
    expect(stack.state()).toMatchObject({ canRedo: false, redoLabel: null, steps: 1 })
  })
})

describe('HistoryStack 合并规则', () => {
  it('同一合并键在窗口内并成一步：保留最早的 before，取最新的 after', () => {
    const clock = fakeClock()
    const stack = new HistoryStack<string>({ now: clock.now })
    stack.push({ label: '修改内容', coalesceKey: 'block:1', before: 'A', after: 'B' })
    clock.tick(200)
    const merged = stack.push({ label: '修改内容', coalesceKey: 'block:1', before: 'B', after: 'C' })
    expect(merged).toBe(true)
    expect(stack.state().steps).toBe(1)
    expect(stack.undo()?.before).toBe('A')
    stack.redo()
    expect(stack.state().steps).toBe(1)
  })

  it('超出合并窗口就另起一步', () => {
    const clock = fakeClock()
    const stack = new HistoryStack<string>({ now: clock.now })
    stack.push({ label: '修改内容', coalesceKey: 'block:1', before: 'A', after: 'B' })
    clock.tick(601)
    stack.push({ label: '修改内容', coalesceKey: 'block:1', before: 'B', after: 'C' })
    expect(stack.state().steps).toBe(2)
  })

  it('换了编辑对象就另起一步', () => {
    const clock = fakeClock()
    const stack = new HistoryStack<string>({ now: clock.now })
    stack.push({ label: '修改内容', coalesceKey: 'block:1', before: 'A', after: 'B' })
    clock.tick(100)
    stack.push({ label: '修改内容', coalesceKey: 'block:2', before: 'B', after: 'C' })
    expect(stack.state().steps).toBe(2)
  })

  it('没有合并键的步骤永不合并', () => {
    const clock = fakeClock()
    const stack = new HistoryStack<string>({ now: clock.now })
    stack.push({ label: '删除内容', before: 'A', after: 'B' })
    clock.tick(10)
    stack.push({ label: '删除内容', before: 'B', after: 'C' })
    expect(stack.state().steps).toBe(2)
  })

  it('seal 之后不再合并（保存时封口）', () => {
    const clock = fakeClock()
    const stack = new HistoryStack<string>({ now: clock.now })
    stack.push({ label: '修改内容', coalesceKey: 'block:1', before: 'A', after: 'B' })
    clock.tick(10)
    stack.seal()
    stack.push({ label: '修改内容', coalesceKey: 'block:1', before: 'B', after: 'C' })
    expect(stack.state().steps).toBe(2)
  })
})

describe('HistoryStack 上限', () => {
  it('超过步数上限从最旧开始丢，最新一步始终在', () => {
    const stack = new HistoryStack<string>({ maxSteps: 3 })
    for (const [i, pair] of [
      ['a1', 'a2'],
      ['b1', 'b2'],
      ['c1', 'c2'],
      ['d1', 'd2']
    ].entries()) {
      stack.push({ label: `第 ${i + 1} 步`, before: pair[0]!, after: pair[1]! })
    }
    expect(stack.state().steps).toBe(3)
    expect(stack.state().undoLabel).toBe('第 4 步')
    // 连撤三次到最旧保留的那一步（第 2 步）
    expect(stack.undo()?.before).toBe('d1')
    expect(stack.undo()?.before).toBe('c1')
    expect(stack.undo()?.before).toBe('b1')
    expect(stack.undo()).toBeNull()
  })

  it('超过字节上限也丢最旧，但至少留一条', () => {
    const stack = new HistoryStack<string>({ maxSteps: 10, maxBytes: 12, measure: (s) => s.length })
    stack.push({ label: '第一步', before: 'aaaaaaaa', after: 'bbbbbbbb' })
    stack.push({ label: '第二步', before: 'cccccccc', after: 'dddddddd' })
    expect(stack.state().steps).toBe(1)
    expect(stack.state().undoLabel).toBe('第二步')
  })

  it('clear 清空两个栈并封口', () => {
    const clock = fakeClock()
    const stack = new HistoryStack<string>({ now: clock.now })
    stack.push({ label: '修改内容', coalesceKey: 'block:1', before: 'A', after: 'B' })
    stack.undo()
    stack.clear()
    expect(stack.state()).toMatchObject({ canUndo: false, canRedo: false, steps: 0 })
    clock.tick(10)
    const merged = stack.push({ label: '修改内容', coalesceKey: 'block:1', before: 'A', after: 'B' })
    expect(merged).toBe(false)
  })
})
