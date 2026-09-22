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

/**
 * 反过来：从校验结论的 JSON 路径里取回"从根往下走的下标"。
 * 认不出来（`name`、`styleTemplate` 这种整份文档级的结论）返回 null。
 */
export function nodePathFromJsonPath(jsonPath: string): NodePath | null {
  if (jsonPath === 'root') return []
  if (!jsonPath.startsWith('root.children[')) return null
  const out: number[] = []
  let rest = jsonPath.slice('root'.length)
  while (rest.startsWith('.children[')) {
    const close = rest.indexOf(']')
    if (close < 0) return null
    const index = Number.parseInt(rest.slice('.children['.length, close), 10)
    if (!Number.isFinite(index)) return null
    out.push(index)
    rest = rest.slice(close + 1)
  }
  return out
}

/**
 * 节点"在哪"：祖先标题串起来（示例文档 › 需求 › 标识），取不到就返回空串。
 * 写给人看的定位——结构本来就能从中栏的树一眼看到，JSON 下标只有改文件的人才需要。
 */
export function breadcrumbOf(doc: TemplateDoc | null, path: NodePath): string {
  const parts: string[] = []
  for (let depth = 0; depth <= path.length; depth += 1) {
    const node = nodeAt(doc, path.slice(0, depth))
    if (!node) return ''
    parts.push(nodeTitle(node) || '（未命名）')
  }
  return parts.join(' › ')
}

/**
 * 校验结论的位置：标题串 + 第几块（示例文档 › 需求 · 第 2 块）。
 * 整份文档级的结论没有"在哪个节点"可言，返回 null——面板与卡片上干脆不显示位置。
 */
export function issueLocation(doc: TemplateDoc | null, issuePath: string): string | null {
  const path = nodePathFromJsonPath(issuePath)
  if (!path) return null
  const where = breadcrumbOf(doc, path)
  if (where === '') return null
  const block = /\.contentBlocks\[(\d+)\]/.exec(issuePath)
  return block ? `${where} · 第 ${Number(block[1]) + 1} 块` : where
}

/** 结论按"在哪儿"归的一堆：状态栏那份索引按它排（逐条原话在节点详情里说） */
export interface IssueGroup {
  /** 人话位置；整份文档级的结论没有位置，是 null */
  where: string | null
  /** 位置对应的节点路径（可以点着跳过去）；没有位置的是 null */
  path: NodePath | null
  errors: number
  warnings: number
  /** 只有"没有位置"的那一组带原话：别处的原话都由节点面板逐条说，这里不重复 */
  messages: string[]
}

/**
 * 把结论按位置归堆：同一处（同一个节点/同一块）的结论合成一行，
 * 只数错误与提示的条数——状态栏那份索引是"问题在哪"，不是把面板里的话再说一遍。
 */
export function groupIssuesByLocation(
  doc: TemplateDoc | null,
  issues: readonly { level: string; path: string; message: string }[]
): IssueGroup[] {
  const out: IssueGroup[] = []
  const byKey = new Map<string, IssueGroup>()
  for (const issue of issues) {
    const path = nodePathFromJsonPath(issue.path)
    const where = issueLocation(doc, issue.path)
    const key = where ?? '(doc)'
    let group = byKey.get(key)
    if (!group) {
      group = { where, path: where ? path : null, errors: 0, warnings: 0, messages: [] }
      byKey.set(key, group)
      out.push(group)
    }
    if (issue.level === 'error') group.errors += 1
    else group.warnings += 1
    // 位置说不清的（整份模板级的结论）只能在这儿把原话说出来
    if (where === null) group.messages.push(issue.message)
  }
  // 没有位置的排最后：它说的是整份模板，不是某一处
  return out.sort((a, b) => (a.where === null ? 1 : 0) - (b.where === null ? 1 : 0))
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
 * 为什么不照原样显示 `nodeType`：模板里 100 个 section、41 个 chapter，而这两个词程序一个都不读，
 * 级别也早由行首那颗数字说清了；界面只认两种用途（见 nodeKind）：
 *   - 层级标题：素色数字标记，没什么可额外标的；
 *   - 列表子标题：带色圆圈数字标记（含"同级里第几项"），也不需要再挂一个词。
 * 认不出的取值照原样显示：那多半是拼错了，得让人看见。
 */
export function nodeTypeBadge(node: TemplateObject): string | null {
  const kind = nodeKind(node)
  return kind === 'unknown' ? nodeType(node) : null
}

/**
 * 节点在界面上的"用途"，只有两种（没有第三种）：
 *   - `heading`      层级标题：进章节编号链，导出用 `heading.<级别>`；
 *   - `listSubTitle` 列表子标题：不占编号链，导出按同级里的 a/b/c 编号（`subtitle.<深度>`）。
 *
 * 文件里那串英文类型名对作者没有意义，程序也只对 `subTitle`（列表子标题）分支：
 * `root` 只被几条检查用到，`chapter` / `section`（真实模板里 chapter 出现在 1~3 层、
 * section 在 2~5 层，连"第几层叫什么"都不是固定约定）与 `repeatable` 全库没有一处读它们——
 * 复制组那件事由 `copyGroupId` 决定，与这个字段无关，所以按层级标题对待、值原样留着。
 */
export type NodeKind = 'heading' | 'listSubTitle' | 'unknown'

export function nodeKind(node: TemplateObject): NodeKind {
  const type = nodeType(node)
  if (type === 'subTitle' || type === 'subtitle') return 'listSubTitle'
  if (
    type === '' ||
    type === 'root' ||
    type === 'chapter' ||
    type === 'section' ||
    type === 'repeatable'
  ) {
    return 'heading'
  }
  return 'unknown'
}

/** 层级标题在文件里的写法：一级 chapter、更深 section（与现有模板一致，这两个词本身无语义） */
export function normalNodeTypeFor(level: number): string {
  return level <= 1 ? 'chapter' : 'section'
}

/** 标题级别的界面取值：模板里没写时按加载器的缺省（1）显示 */
export function headingLevel(node: TemplateObject): number {
  return num(node['headingLevel'], 1)
}

/**
 * 列表子标题的层级：这一支上（含自己）有几个列表子标题，与 core 的 `subTitleDepth()`
 * 同一套算法——导出取的就是它（`subtitle.<这个数>`），**不是**节点在树里的第几层。
 * 层级标题的层级则取文件里的 `headingLevel`（见 `headingLevel`）。
 */
export function subTitleDepthOf(doc: TemplateDoc | null, path: NodePath): number {
  let depth = 0
  for (let i = 0; i <= path.length; i += 1) {
    const node = nodeAt(doc, path.slice(0, i))
    if (node && nodeKind(node) === 'listSubTitle') depth += 1
  }
  return depth
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

/**
 * keep / readonly 两档是"必须存在 + 位置也不能变"：不能删、顺序也不能改。
 * 模板作者在模板编辑页里同样受这条约束（要挪/要删就先把锁改成不锁）——
 * 生成出来的工程里，写入侧与界面也按同一条守。
 */
export function isPinnedLock(lock: string): boolean {
  return lock === 'keep' || lock === 'readonly'
}

/** 锁档位的人话名字（提示语里用） */
export function lockLevelName(lock: string): string {
  if (lock === 'keep') return '锁删除与移动'
  if (lock === 'readonly') return '只读'
  if (lock === 'type') return '只锁类型'
  return '不锁'
}

/** 界面替作者维护的字段名：其余字段原样保留 */
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

/**
 * 字段名与某个已知字段只差大小写（headingLevel 写成 headinglevel 这类）：
 * 程序读不到那个键、会当没写，界面上也没有它的位置——不说的话就是个看不见的坑。
 * 只认"大小写不同"，不做模糊匹配：那种误报比漏报更烦人。
 * （其余不认识的键不再逐个提示：保存时整份原样写回是全局约定，逐节点声明只是噪音。）
 */
export function typoField(
  obj: TemplateObject,
  known: readonly string[]
): { key: string; known: string } | null {
  for (const key of Object.keys(obj)) {
    if (known.includes(key)) continue
    const match = known.find(
      (candidate) => candidate !== key && candidate.toLowerCase() === key.toLowerCase()
    )
    if (match) return { key, known: match }
  }
  return null
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

/**
 * 同一父节点下**不许混**：要么全是层级标题，要么全是列表子标题——严格限制
 * （真实模板 5 套 + 样例 1 套全都守着它，0 处混着；混了会出问题）。
 * 已知会撞的一条：列表子标题下面只能挂列表子标题（加载器 `DocumentNode.canAccept`
 * 直接拒收），而列表子标题的样式按算出来的 `subtitle.N` 取、不占章节编号链。
 * 所以新建节点与改类型都得先问这一组是什么，见下面三个函数。
 */

/** 一组节点的类别：都是层级标题 / 都是列表子标题 / 混着（已经违规了） */
export type SiblingKind = 'heading' | 'listSubTitle' | 'mixed'

/** 一组节点是什么类别；空组是 null */
function groupKind(nodes: readonly unknown[]): SiblingKind | null {
  const kinds = nodes
    .map((child) => asObject(child))
    .filter((child): child is TemplateObject => child !== null)
    .map((child) => nodeKind(child))
    .filter((kind): kind is 'heading' | 'listSubTitle' => kind !== 'unknown')
  if (kinds.length === 0) return null
  const hasHeading = kinds.includes('heading')
  const hasSub = kinds.includes('listSubTitle')
  if (hasHeading && hasSub) return 'mixed'
  return hasSub ? 'listSubTitle' : 'heading'
}

/** 兄弟组的类别（含自己）：一组兄弟要么都是层级标题、要么都是列表子标题；没有兄弟时是 null */
export function siblingKindOf(doc: TemplateDoc | null, path: NodePath): SiblingKind | null {
  if (path.length === 0) return null
  const parent = nodeAt(doc, path.slice(0, -1))
  if (!parent) return null
  return groupKind(rawChildren(parent))
}

/**
 * 这个节点**别的**兄弟是什么类别（不含自己）：改类型时只看别人，
 * 因为"自己是同类"不算混——一个独生子想改成哪种都行。
 */
function otherSiblingsKind(doc: TemplateDoc | null, path: NodePath): SiblingKind | null {
  if (path.length === 0) return null
  const index = path[path.length - 1] ?? 0
  const parent = nodeAt(doc, path.slice(0, -1))
  if (!parent) return null
  return groupKind(rawChildren(parent).filter((_, i) => i !== index))
}

/**
 * 在这个节点下加子节点时，新节点该是什么类别：
 *   - 父节点自己是列表子标题 → 只能是列表子标题（加载器的硬规则）；
 *   - 父节点下已经有列表子标题 → 也是列表子标题（不能混）；
 *   - 其余（含空组）→ 层级标题。
 * 组已经混着时按列表子标题加：那种组本来就得作者自己收拾，程序只能挑一边，
 * 挑"更严格"的那边（列表子标题下面只能挂列表子标题）。
 */
export function childKindFor(doc: TemplateDoc | null, path: NodePath): 'heading' | 'listSubTitle' {
  const parent = nodeAt(doc, path)
  if (!parent) return 'heading'
  if (nodeKind(parent) === 'listSubTitle') return 'listSubTitle'
  const group = groupKind(rawChildren(parent))
  return group === 'heading' || group === null ? 'heading' : 'listSubTitle'
}

/**
 * 把选中节点改成 `kind` 行不行：行就返回 null，不行返回一句为什么（界面照它说明并禁用）。
 * 两头都要看：
 *   - 兄弟那一头：**别的**兄弟是另一种（或那一组已经混着）时不能改，改了就是混着的一层；
 *   - 子节点那一头：它已经有层级标题的子节点时，不能把它改成列表子标题
 *     （列表子标题下挂层级标题，加载器会拒收）。
 */
export function kindChangeProblem(
  doc: TemplateDoc | null,
  path: NodePath,
  kind: 'heading' | 'listSubTitle'
): string | null {
  const node = nodeAt(doc, path)
  if (!node) return '节点已不在树里'
  if (path.length === 0) return '根节点无类型'
  if (nodeKind(node) === kind) return null
  const others = otherSiblingsKind(doc, path)
  if (others !== null && others !== kind) {
    if (others === 'mixed') return '同级类型混用'
    return others === 'listSubTitle' ? '同级均为列表子标题' : '同级均为层级标题'
  }
  if (kind === 'listSubTitle') {
    const headingChildren = rawChildren(node).filter(
      (child) => nodeKind(asObject(child) ?? {}) === 'heading'
    ).length
    if (headingChildren > 0) {
      return `下挂 ${headingChildren} 个层级标题 · 此处只允许列表子标题`
    }
  }
  return null
}

/**
 * 一组已经不合规时该怎么改齐（"直接修复，不留着"）：
 *   - `children`：列表子标题下面挂着层级标题（加载器会拒收），或子节点里两种混着；
 *   - `siblings`：它和同级混着（同一父节点下不许混）。
 * `target` 是改完之后的类别，`paths` 是要改的那几个节点（已经是目标类别的不用改）。
 * 合规的结构返回 null——这时界面上不该有"改齐"这个动作。
 */
export interface GroupFix {
  scope: 'children' | 'siblings'
  target: 'heading' | 'listSubTitle'
  paths: NodePath[]
  /** 一句话说清这一组现在哪里不合规 */
  why: string
}

/** 一组节点里各是哪一类（认不出的取值不参与：程序不改作者写歪了的原值） */
function kindsOf(nodes: readonly unknown[]): Array<'heading' | 'listSubTitle'> {
  return nodes
    .map((child) => asObject(child))
    .filter((child): child is TemplateObject => child !== null)
    .map((child) => nodeKind(child))
    .filter((kind): kind is 'heading' | 'listSubTitle' => kind !== 'unknown')
}

/** 少数派是哪一类（用于"子节点混着"时挑一个改齐的目标；平手按层级标题） */
function majorityKind(kinds: ReadonlyArray<'heading' | 'listSubTitle'>): 'heading' | 'listSubTitle' {
  const headings = kinds.filter((k) => k === 'heading').length
  return headings * 2 >= kinds.length ? 'heading' : 'listSubTitle'
}

export function groupFixFor(doc: TemplateDoc | null, path: NodePath): GroupFix | null {
  const node = nodeAt(doc, path)
  if (!node) return null
  const children = rawChildren(node)
  const childKinds = kindsOf(children)
  /** 子节点下标（原始顺序），按类别挑出来 */
  const childPathsOf = (kind: 'heading' | 'listSubTitle'): NodePath[] =>
    children
      .map((child, index) => ({ child: asObject(child), index }))
      .filter((item) => item.child !== null && nodeKind(item.child) === kind)
      .map((item) => [...path, item.index])

  // ① 子节点这一头：列表子标题下面挂层级标题是硬违规（加载器直接拒收）
  if (nodeKind(node) === 'listSubTitle') {
    const bad = childPathsOf('heading')
    if (bad.length > 0) {
      return {
        scope: 'children',
        target: 'listSubTitle',
        paths: bad,
        why: `下挂 ${bad.length} 个层级标题 · 此处只允许列表子标题`
      }
    }
  }
  // ② 子节点混着：按多数那一类改齐
  if (childKinds.includes('heading') && childKinds.includes('listSubTitle')) {
    const target = majorityKind(childKinds)
    return {
      scope: 'children',
      target,
      paths: childPathsOf(target === 'heading' ? 'listSubTitle' : 'heading'),
      why: '子节点类型混用'
    }
  }
  // ③ 兄弟这一头：跟同级混着，按自己这一类改齐（作者选谁就以谁为准）
  if (path.length > 0 && siblingKindOf(doc, path) === 'mixed') {
    const own = nodeKind(node)
    const target: 'heading' | 'listSubTitle' = own === 'unknown' ? 'heading' : own
    const index = path[path.length - 1] ?? 0
    const parent = nodeAt(doc, path.slice(0, -1))
    const paths = parent
      ? rawChildren(parent)
          .map((child, i) => ({ child, i }))
          .filter(
            (item) =>
              item.i !== index &&
              nodeKind(asObject(item.child) ?? {}) ===
                (target === 'heading' ? 'listSubTitle' : 'heading')
          )
          .map((item) => [...path.slice(0, -1), item.i])
      : []
    return {
      scope: 'siblings',
      target,
      paths,
      why: '同级类型混用'
    }
  }
  return null
}

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

/** 复制一块（连同内容与锁）插在它下面：模板作者常拿现成的一块当草稿 */
export function duplicateBlockAt(doc: TemplateDoc, nodePath: NodePath, index: number): TemplateDoc {
  const node = nodeAt(doc, nodePath)
  const source = node ? asObject(rawBlocks(node)[index]) : null
  // 下标不对就当没这回事：返回原来那份 doc，免得"什么都没改"却被标成有改动
  if (!source) return doc
  return patchWithin(doc, nodePath, (target) => {
    const blocks = [...rawBlocks(target)]
    blocks.splice(index + 1, 0, cloneJson(source) as TemplateObject)
    return { ...target, contentBlocks: blocks }
  })
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
