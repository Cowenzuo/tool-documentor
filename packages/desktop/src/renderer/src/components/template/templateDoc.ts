/**
 * 模板草稿的模型层（结构模板 JSON）：整份 doc 是唯一真源，改动按节点路径做不可变更新。
 *
 * 口径与模板仓库的写法对齐，只认结构模板已有的字段形状：
 *   - 节点：nodeType / title / headingLevel / description / copyable / deletable /
 *     allowContentBlocks / children / contentBlocks
 *   - 内容块：type / lock / 按类型的初始内容字段（text 用 content，code 用 language + content，
 *     mermaid 用 caption + content，image 用 content + caption，列表用 items，表格用
 *     caption / rows / cols / headers / data / mergeVertical）
 * 没认得的字段一律原样留着——保存时整份 doc 回写，界面不做字段裁剪。
 *
 * 节点定位用「从根往下走的子节点下标」（NodePath）：下标与 JSON 里的下标一一对应，
 * 所以不往 doc 里塞任何合成 id，也不改动原文。
 */
import { BLOCK_LOCK_LEVELS } from '@documentor/core/blocks'

export type TemplateDoc = Record<string, unknown>
/** 模板 JSON 里的一层对象（节点或内容块） */
export type TemplateObject = Record<string, unknown>
/** 从根节点往下走的子节点下标；[] 就是根节点本身 */
export type NodePath = readonly number[]

export const ROOT_PATH: NodePath = []

/** 展开集合与选中比较用的路径键：根是空串，子节点是 '0.2.1' */
export function pathKey(path: NodePath): string {
  return path.join('.')
}

/** 与校验结论同一套位置写法：root.children[0].children[2] */
export function nodeJsonPath(path: NodePath): string {
  let out = 'root'
  for (const index of path) out += `.children[${index}]`
  return out
}

export function asObject(value: unknown): TemplateObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as TemplateObject)
    : null
}

export function rootNode(doc: TemplateDoc | null): TemplateObject | null {
  return doc ? asObject(doc['root']) : null
}

/** 按路径取节点；路径不存在（或中间有坏条目）返回 null */
export function nodeAt(doc: TemplateDoc | null, path: NodePath): TemplateObject | null {
  const root = rootNode(doc)
  if (!root) return null
  let current: TemplateObject = root
  for (const index of path) {
    const child = asObject(rawChildren(current)[index])
    if (!child) return null
    current = child
  }
  return current
}

/** 子节点原数组；下标要与 JSON 对齐，所以坏条目也占位，不在这里过滤 */
export function rawChildren(node: TemplateObject): unknown[] {
  const children = node['children']
  return Array.isArray(children) ? children : []
}

export function hasChildren(node: TemplateObject): boolean {
  return rawChildren(node).some((child) => asObject(child) !== null)
}

export function rawBlocks(node: TemplateObject): unknown[] {
  const blocks = node['contentBlocks']
  return Array.isArray(blocks) ? blocks : []
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)
}

export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const parsed = Number.parseInt(str(value), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function nodeTitle(node: TemplateObject): string {
  return str(node['title'])
}

export function nodeType(node: TemplateObject): string {
  return str(node['nodeType'])
}

/**
 * 节点树行上该显示的"类型标记"（没有就返回 null）。
 *
 * 为什么不照原样显示 `nodeType`：真实模板里 100 个 section、41 个 chapter，
 * 而 `chapter` / `section` / `root` 的层级已经由行首那颗级别数字说清了，再挂一个英文类型
 * 就是同一件事说两遍（and 是给程序看的字段名，不是给人看的）。
 * 只有下面这两类"和普通节点不一样、且影响用户怎么用"的才值得占用行上的位置：
 *   - `repeatable`：可复制组，用户在新工程里能整组复制（导出侧也按组计数）；
 *   - `subTitle`：副标题，不占标题编号链，导出侧另有 a/b/c 编号（见 subTitleStyle）。
 * 认不出的取值照原样显示：那多半是拼错了，得让人看见（校验也会报）。
 */
export function nodeTypeBadge(node: TemplateObject): string | null {
  const type = nodeType(node)
  if (type === '' || type === 'root' || type === 'chapter' || type === 'section') return null
  if (type === 'repeatable') return '可复制组'
  if (type === 'subTitle') return '副标题'
  return type
}

/** 标题级别的界面取值：模板里没写时按加载器的缺省（1）显示 */
export function headingLevel(node: TemplateObject): number {
  return num(node['headingLevel'], 1)
}

export function blockType(block: TemplateObject): string {
  return str(block['type'])
}

/**
 * 内容块的一行摘要：折叠时卡片头上显示它，让人不必展开就知道这块是什么。
 * 口径与主编辑器 `summarizeBlock` 一致（那边读的是工程块，这边读模板 JSON），
 * 标题优先，其次内容首行，最后按类型给规模。
 */
export function blockSummary(block: TemplateObject): string {
  const cut = (text: string, max = 60): string => {
    const one = text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? text.trim()
    return one.length > max ? `${one.slice(0, max)}…` : one
  }
  const type = blockType(block)
  const caption = str(block['caption']).trim()
  const content = str(block['content'])
  switch (type) {
    case 'text':
      return cut(content) || '（空段落）'
    case 'orderedList':
    case 'unorderedList': {
      const items = Array.isArray(block['items']) ? (block['items'] as unknown[]) : []
      if (items.length === 0) return '（空列表）'
      return `${items.length} 条 · ${cut(str(items[0]))}`
    }
    case 'table': {
      const rows = Array.isArray(block['data']) ? (block['data'] as unknown[]) : []
      const cols = Math.max(
        num(block['cols'], 0),
        Array.isArray(block['headers']) ? (block['headers'] as unknown[]).length : 0,
        ...rows.map((row) => (Array.isArray(row) ? row.length : 0))
      )
      const size = `${rows.length} 行 × ${cols} 列`
      return caption ? `${caption} · ${size}` : size
    }
    case 'image':
      return caption || cut(content) || '（没给图片路径）'
    case 'mermaid':
      return caption ? `${caption} · ${cut(content, 40)}` : cut(content) || '（空图）'
    case 'code': {
      const lang = str(block['language']).trim()
      const head = cut(content, 50)
      return head ? `${lang ? `${lang} · ` : ''}${head}` : lang || '（空代码）'
    }
    case 'formula':
      return cut(content) || '（空公式）'
    default:
      return type === '' ? '（未写类型）' : `${type}（界面不认的类型）`
  }
}

/**
 * 三个开关的生效值（与模板加载器的缺省一致，见 packages/templates/src/manager.ts）：
 * copyable / deletable 缺省 false；allowContentBlocks 缺省 true。
 */
export function nodeSwitch(
  node: TemplateObject,
  key: 'copyable' | 'deletable' | 'allowContentBlocks'
): boolean {
  const raw = node[key]
  if (key === 'allowContentBlocks') return raw === undefined ? true : raw === true
  return raw === true
}

/**
 * 锁档位：'' 表示不锁（模板里没写这个键）。
 * 非法取值也按不锁返回——它会以「原值」出现在下拉里，由校验去报，
 * 不让界面把读不懂的取值悄悄改掉。
 */
export function blockLock(block: TemplateObject): string {
  const raw = block['lock']
  if (typeof raw !== 'string') return ''
  return (BLOCK_LOCK_LEVELS as readonly string[]).includes(raw) ? raw : ''
}

/** 模板里写了、但不认识的锁取值（下拉里要显示原值，不能吞掉） */
export function rawBlockLock(block: TemplateObject): string | null {
  const raw = block['lock']
  if (raw === undefined) return null
  const value = str(raw)
  return (BLOCK_LOCK_LEVELS as readonly string[]).includes(value) ? null : value
}

/** 这份模板里出现过的节点类型（下拉先给这些） */
export function collectNodeTypes(doc: TemplateDoc | null): string[] {
  const out: string[] = []
  const walk = (node: TemplateObject): void => {
    const type = nodeType(node)
    if (type && !out.includes(type)) out.push(type)
    for (const child of rawChildren(node)) {
      const next = asObject(child)
      if (next) walk(next)
    }
  }
  const root = rootNode(doc)
  if (root) walk(root)
  return out
}

/** 常见节点类型：模板里一个都没出现时（例如刚新建的空模板）也能往下选 */
const BASE_NODE_TYPES = ['root', 'chapter', 'section', 'subTitle', 'repeatable']

export function nodeTypeOptions(doc: TemplateDoc | null, current: string): string[] {
  const out = collectNodeTypes(doc)
  for (const type of BASE_NODE_TYPES) if (!out.includes(type)) out.push(type)
  if (current && !out.includes(current)) out.push(current)
  return out
}

/** 界面替作者维护的字段名：其余字段原样保留，界面上列出来让人看得见 */
export const NODE_FIELDS = [
  'nodeType',
  'title',
  'headingLevel',
  'description',
  'copyable',
  'deletable',
  'allowContentBlocks',
  'children',
  'contentBlocks'
] as const

export const BLOCK_FIELDS = [
  'type',
  'lock',
  'content',
  'language',
  'caption',
  'items',
  'rows',
  'cols',
  'headers',
  'data',
  'mergeVertical'
] as const

export function unknownKeys(obj: TemplateObject, known: readonly string[]): string[] {
  return Object.keys(obj).filter((key) => !known.includes(key))
}

/** 递归累加节点；visit 的返回值不用，只借这一次遍历 */
function sumTree(node: TemplateObject, visit: (node: TemplateObject) => void): void {
  visit(node)
  for (const child of rawChildren(node)) {
    const next = asObject(child)
    if (next) sumTree(next, visit)
  }
}

export function countNodes(doc: TemplateDoc | null): number {
  const root = rootNode(doc)
  if (!root) return 0
  let total = 0
  sumTree(root, () => {
    total += 1
  })
  return total
}

export function countBlocks(doc: TemplateDoc | null): number {
  const root = rootNode(doc)
  if (!root) return 0
  let total = 0
  sumTree(root, (node) => {
    total += rawBlocks(node).length
  })
  return total
}

/** 有子节点的那些节点的路径键：默认全展开时用它 */
export function expandableKeys(doc: TemplateDoc | null): Set<string> {
  const out = new Set<string>()
  const walk = (node: TemplateObject, path: NodePath): void => {
    rawChildren(node).forEach((child, index) => {
      const next = asObject(child)
      if (!next) return
      const childPath = [...path, index]
      if (hasChildren(next)) out.add(pathKey(childPath))
      walk(next, childPath)
    })
  }
  const root = rootNode(doc)
  if (root) walk(root, ROOT_PATH)
  return out
}

// ================= 新建节点与内容块 =================

export function createTemplateNode(level: number, type = 'chapter'): TemplateObject {
  return {
    nodeType: type,
    title: '',
    headingLevel: Math.max(0, level),
    description: '',
    copyable: false,
    deletable: false,
    allowContentBlocks: false,
    children: []
  }
}

/** 新内容块的初始内容：加进来就能存（mermaid 给一张最小可用图，空着会被校验拦住） */
export function createTemplateBlock(type: string): TemplateObject {
  switch (type) {
    case 'text':
      return { type, content: '' }
    case 'image':
      return { type, content: '', caption: '' }
    case 'table':
      return { type, caption: '', rows: 1, cols: 1, headers: [''], data: [['']] }
    case 'formula':
      return { type, content: '' }
    case 'code':
      return { type, language: 'cpp', content: '' }
    case 'mermaid':
      return { type, content: 'flowchart LR\n    A[开始] --> B[结束]', caption: '' }
    case 'orderedList':
    case 'unorderedList':
      return { type, items: [''] }
    default:
      throw new Error(`未知内容块类型: ${type}`)
  }
}

// ================= 不可变改动 =================

/** 沿路径重建节点链；路径上有坏条目时返回 null，调用方按"没改动"处理 */
function rebuild(
  node: TemplateObject,
  path: NodePath,
  fn: (target: TemplateObject) => TemplateObject
): TemplateObject | null {
  const head = path[0]
  if (head === undefined) return fn(node)
  const children = rawChildren(node)
  const child = asObject(children[head])
  if (!child) return null
  const nextChild = rebuild(child, path.slice(1), fn)
  if (!nextChild) return null
  const nextChildren = [...children]
  nextChildren[head] = nextChild
  return { ...node, children: nextChildren }
}

function writeRoot(doc: TemplateDoc, next: TemplateObject | null): TemplateDoc {
  return next ? { ...doc, root: next } : doc
}

/**
 * 合并一次字段改动。值为 undefined 的键是**删掉这个键**：
 * 界面上"不锁 / 不开合并"就该与模板里"从没写过"完全一致，
 * 留一个值为 undefined 的同名键会让"写过没有"这件事在内存里说不清。
 */
function mergePatch(target: TemplateObject, patch: TemplateObject): TemplateObject {
  const next: TemplateObject = { ...target, ...patch }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key]
  }
  return next
}

export function patchNodeAt(
  doc: TemplateDoc,
  path: NodePath,
  patch: TemplateObject
): TemplateDoc {
  const root = rootNode(doc)
  if (!root) return doc
  return writeRoot(
    doc,
    rebuild(root, path, (node) => mergePatch(node, patch))
  )
}

function patchWithin(
  doc: TemplateDoc,
  path: NodePath,
  op: (node: TemplateObject) => TemplateObject
): TemplateDoc {
  const root = rootNode(doc)
  if (!root) return doc
  return writeRoot(doc, rebuild(root, path, op))
}

export function insertChildAt(doc: TemplateDoc, path: NodePath, node: TemplateObject): TemplateDoc {
  return patchWithin(doc, path, (parent) => ({
    ...parent,
    children: [...rawChildren(parent), node]
  }))
}

/** 插到某个节点后面（同级）。根节点没有同级，调用方负责拦住 */
export function insertSiblingAfter(doc: TemplateDoc, path: NodePath, node: TemplateObject): TemplateDoc {
  const index = path[path.length - 1]
  if (index === undefined) return doc
  const parentPath = path.slice(0, -1)
  return patchWithin(doc, parentPath, (parent) => {
    const children = [...rawChildren(parent)]
    children.splice(index + 1, 0, node)
    return { ...parent, children }
  })
}

export function removeNodeAt(doc: TemplateDoc, path: NodePath): TemplateDoc {
  const index = path[path.length - 1]
  if (index === undefined) return doc
  const parentPath = path.slice(0, -1)
  return patchWithin(doc, parentPath, (parent) => ({
    ...parent,
    children: rawChildren(parent).filter((_, i) => i !== index)
  }))
}

/** 节点/内容块的深拷贝：模板 JSON 是纯数据，逐层复制，别让两份共用同一个数组 */
function cloneJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJson)
  const object = asObject(value)
  if (!object) return value
  const out: TemplateObject = {}
  for (const [key, item] of Object.entries(object)) out[key] = cloneJson(item)
  return out
}

/**
 * 复制一份子树，插在原节点后面：模板作者拿现成的一章当草稿最快
 *（子节点与内容块一起带走，标题、开关、锁都照抄，改哪算哪）。
 */
export function duplicateNodeAt(doc: TemplateDoc, path: NodePath): TemplateDoc {
  const index = path[path.length - 1]
  if (index === undefined) return doc
  const parentPath = path.slice(0, -1)
  const parent = nodeAt(doc, parentPath)
  const source = parent ? asObject(rawChildren(parent)[index]) : null
  // 路径不对就当没这回事：返回原来那份 doc，免得"什么都没改"却被标成有改动
  if (!source) return doc
  return patchWithin(doc, parentPath, (target) => {
    const children = [...rawChildren(target)]
    children.splice(index + 1, 0, cloneJson(source) as TemplateObject)
    return { ...target, children }
  })
}

/** 某一支里"能开合"的路径键（含它自己）：菜单里的展开/折叠该分支按这份名单办事 */
export function branchKeys(doc: TemplateDoc | null, path: NodePath): string[] {
  const node = nodeAt(doc, path)
  if (!node) return []
  const out: string[] = []
  const walk = (current: TemplateObject, currentPath: NodePath): void => {
    rawChildren(current).forEach((raw, index) => {
      const child = asObject(raw)
      if (!child) return
      const childPath = [...currentPath, index]
      if (hasChildren(child)) out.push(pathKey(childPath))
      walk(child, childPath)
    })
  }
  if (hasChildren(node)) out.push(pathKey(path))
  walk(node, path)
  return out
}

/** 同级上移/下移：相邻换位，越界不动 */
export function moveNodeIn(doc: TemplateDoc, path: NodePath, delta: -1 | 1): TemplateDoc {
  const index = path[path.length - 1]
  if (index === undefined) return doc
  const parentPath = path.slice(0, -1)
  return patchWithin(doc, parentPath, (parent) => {
    const children = [...rawChildren(parent)]
    const target = index + delta
    if (target < 0 || target >= children.length) return parent
    const a = children[index]
    const b = children[target]
    if (a === undefined || b === undefined) return parent
    children[index] = b
    children[target] = a
    return { ...parent, children }
  })
}

export function patchBlockAt(
  doc: TemplateDoc,
  nodePath: NodePath,
  index: number,
  patch: TemplateObject
): TemplateDoc {
  return patchWithin(doc, nodePath, (node) => {
    const blocks = [...rawBlocks(node)]
    const current = asObject(blocks[index])
    if (!current) return node
    blocks[index] = mergePatch(current, patch)
    return { ...node, contentBlocks: blocks }
  })
}

/** 追加一个内容块（index 省略时排到末尾） */
export function addBlockAt(
  doc: TemplateDoc,
  nodePath: NodePath,
  block: TemplateObject,
  index?: number
): TemplateDoc {
  return patchWithin(doc, nodePath, (node) => {
    const blocks = [...rawBlocks(node)]
    if (typeof index === 'number' && index >= 0 && index <= blocks.length) blocks.splice(index, 0, block)
    else blocks.push(block)
    return { ...node, contentBlocks: blocks }
  })
}

export function removeBlockAt(doc: TemplateDoc, nodePath: NodePath, index: number): TemplateDoc {
  return patchWithin(doc, nodePath, (node) => ({
    ...node,
    contentBlocks: rawBlocks(node).filter((_, i) => i !== index)
  }))
}

export function moveBlockIn(
  doc: TemplateDoc,
  nodePath: NodePath,
  index: number,
  delta: -1 | 1
): TemplateDoc {
  return patchWithin(doc, nodePath, (node) => {
    const blocks = [...rawBlocks(node)]
    const target = index + delta
    if (target < 0 || target >= blocks.length) return node
    const a = blocks[index]
    const b = blocks[target]
    if (a === undefined || b === undefined) return node
    blocks[index] = b
    blocks[target] = a
    return { ...node, contentBlocks: blocks }
  })
}

// ================= 文本 ↔ 字段 =================

/** 多行文本 → 字符串数组：一行一条，末尾那个换行不算一条 */
export function linesToArray(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export function arrayToLines(items: readonly unknown[]): string {
  return items.map((item) => str(item)).join('\n')
}

/** 表格一行 → 文本：单元格用 | 分隔 */
export function rowToLine(cells: readonly unknown[]): string {
  return cells.map((cell) => str(cell)).join(' | ')
}

export function lineToRow(line: string): string[] {
  return line.split('|').map((cell) => cell.trim())
}

export function rowsToText(rows: readonly unknown[]): string {
  return rows.map((row) => (Array.isArray(row) ? rowToLine(row) : str(row))).join('\n')
}

export function textToRows(text: string): string[][] {
  return linesToArray(text).map(lineToRow)
}

/** 表头文本：一行，用 | 分隔 */
export function headersToText(headers: readonly unknown[]): string {
  return rowToLine(headers)
}

export function textToHeaders(text: string): string[] {
  return lineToRow(text)
}
