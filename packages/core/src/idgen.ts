/**
 * 节点 id 生成：进程内自增数字字符串（与旧版 C++ 静态计数器行为一致，id 形如 '1'、'2'）。
 * db 中 node.id 为 TEXT PRIMARY KEY；save 时全量重写，只需进程内唯一。
 */
let nextId = 1

export function nextNodeId(): string {
  const id = String(nextId)
  nextId += 1
  return id
}

/** 打开工程后调用：让计数器越过现存最大数字 id，避免与旧数据冲突 */
export function seedIdCounter(maxNumericId: number): void {
  if (maxNumericId >= nextId) {
    nextId = maxNumericId + 1
  }
}

/** 测试辅助：重置计数器 */
export function resetIdCounterForTest(): void {
  nextId = 1
}
