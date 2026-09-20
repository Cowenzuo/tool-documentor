/**
 * validate.ts — 模板静态校验（结构模板 + 样式模板）：规则的唯一实现。
 *
 * 口径来源是模板仓库的 `dev-scripts/check-templates.cjs`（PLAN-11 批次 0 之前唯一的校验实现）。
 * 本模块把那份脚本的规则逐条搬进产品，**判定条件与文案都照抄**，不做"顺手改进"：
 *   - 判定条件照抄：`localscripts/tests/templates/parallel-check.test.ts` 拿真实模板
 *     与脚本逐条比对结论（同一份模板 → 同一个问题集合）；
 *   - 文案照抄：同一处问题在脚本与本模块里是同一个字符串，界面直接显示即可，
 *     对照测试也比较字符串，不需要再维护一层"规则号 ↔ 文案"的映射。
 * 想改判定条件或文案时，脚本与本模块必须一起改（脚本保留到编辑模式稳定为止，
 * 见 PLAN-11 第 8 节第 7 条）。
 *
 * 三件事：
 *   1. `parseSkeletonIndex(skeletonPath)`：读骨架 styles.xml / numbering.xml，给出可读样式表
 *      （styleId、样式名、段落或字符、字号）与各级标题起始号；
 *   2. `requiredStyleKeys(structureDef)`：按结构模板**实际用到的块**推导必需逻辑样式键；
 *   3. `validateStructureTemplate` / `validateStyleTemplate`：产出
 *      `{ level, path, message }` 列表，`path` 指到具体节点或字段
 *      （如 `root.children[2].contentBlocks[0].lock`）。
 *
 * 输入一律是**模板 JSON 原文**（`JSON.parse` 的结果），不是加载器解析后的
 * `TemplateDef`：脚本判的是原文（节点上有没有写 lock、headingLevel 是不是整数、
 * 块上有没有多写节点级字段），这些信息在解析成 TemplateDef 时就丢了。
 *
 * 不在本模块（目录级规则，批次 1 的服务层拿模板目录时再报，见报告里的规则清单）：
 * manifest 条目缺 id/file、目录与文件不存在、JSON 解析失败、manifest 与 JSON 的 name
 * 不一致、目录里有但 manifest 没登记、同名冲突、"结构声明的样式在 manifest 里没有条目"。
 * 真实模板这七类结论当前都是零条，`parallel-check.test.ts` 会盯住这一点。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BlockLockLevel } from '@documentor/core'

// ================= 常量（与脚本同值；改动前先改脚本） =================

/**
 * 认识的内容块类型（脚本 `BLOCK_TYPES`）。与 `@documentor/core` 的 `BLOCK_TYPE_NAMES`
 * 同值同序，`validate.test.ts` 有一条断言钉住两边不漂移。
 */
export const KNOWN_BLOCK_TYPES = [
  'text',
  'image',
  'table',
  'formula',
  'code',
  'mermaid',
  'orderedList',
  'unorderedList'
] as const

/**
 * 块锁三档（脚本 `LOCK_TIERS`，PLAN-09 内容块锁定方案）。**顺序参与文案**：
 * 非法取值时按 `"type" / "keep" / "readonly"` 列出，不要调整。
 * 与 `@documentor/core` 的 `BLOCK_LOCK_LEVELS` 同值同序。
 */
export const LOCK_TIERS: readonly BlockLockLevel[] = ['type', 'keep', 'readonly']

/** 骨架必需部件（脚本 checkStyle 的 needParts），顺序参与文案 */
const SKELETON_REQUIRED_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'word/document.xml',
  'word/styles.xml',
  'word/numbering.xml'
] as const

/** 程序不读的高阶列表键（脚本 checkStyle 里逐个点名的四个） */
const UNREAD_LIST_KEYS = [
  'list.ordered.2',
  'list.ordered.3',
  'list.unordered.2',
  'list.unordered.3'
] as const

/** 题注编号合法的三个取值（脚本 checkStyle 内联的数组） */
const CAPTION_MODES = ['auto', 'static', 'field'] as const

// ================= 对外类型 =================

export type ValidationLevel = 'error' | 'warn'

/**
 * 一条校验结论。
 * - `path`：出问题的位置，JSON 路径（`root.children[2].contentBlocks[0].lock`）或字段/部件名
 *   （`styleMap['body']`、`skeleton/word/styles.xml`）；
 * - `message`：与 `check-templates.cjs` **逐字一致**的说明文案，可直接展示给模板作者；
 * - `rule`：稳定的规则标识（如 `block.lock.invalid`），供界面分组、过滤与后续替换文案时引用。
 */
export interface ValidationIssue {
  level: ValidationLevel
  path: string
  message: string
  rule: string
}

/** 骨架里的一条样式（从 `<w:style>` 元素解析出的可读属性） */
export interface SkeletonStyleInfo {
  /** `w:styleId`，styleMap 里引用的就是它 */
  styleId: string
  /** `w:name w:val`，Word 界面上的样式名（如「标题 1」） */
  name: string
  /** `w:type`：paragraph 段落 / character 字符 / table / numbering；没写就是空串 */
  type: string
  /** 是不是默认样式（`w:default="1"`） */
  isDefault: boolean
  /** `w:basedOn w:val` */
  basedOn?: string
  /** `w:sz w:val`，半磅（24 = 12pt = 小四） */
  fontSizeHalfPoints?: number
  /** 由 `fontSizeHalfPoints` 换算的磅值（24 → 12） */
  fontSizePt?: number
}

/** 骨架索引：样式表 + 各级标题起始号 */
export interface SkeletonIndex {
  skeletonPath: string
  /**
   * 字面扫描 `styleId="..."` 得到的全部 styleId，按出现顺序去重。
   * 这是**校验用的口径**（与 check-templates.cjs 和 manager.ts 的 validateStyleTemplate 同法），
   * 与下面的 `styles` 分开：`styles` 是给人看的可读表，`styleIds` 是判定用的集合。
   */
  styleIds: string[]
  /** 从 `<w:style>` 元素解析出的可读样式表（没有 `w:styleId` 的元素不进来，它没法被引用） */
  styles: SkeletonStyleInfo[]
  /**
   * 各级标题起始号：下标 = `w:ilvl`，值 = 该层的 `<w:start w:val>`。
   * 读不到 `word/numbering.xml`、没有 `abstractNum`、或一个起始号都没读到时为 `undefined`。
   */
  headingStarts?: number[]
}

/** `validateStructureTemplate` 的选项：只影响文件级检查的措辞与 manifest 比对 */
export interface StructureValidateOptions {
  /** 模板 id（脚本用 manifest 的 id）；缺省取结构 JSON 的 name，再缺省「(未命名)」 */
  id?: string
  /** manifest 里的 file 名；给了才拼得出 `structures/<id>/<file>` 这种文件级措辞 */
  file?: string
  /** manifest 里的 name，用于报"manifest 与结构文件名字不一致" */
  manifestName?: string
}

/** `validateStyleTemplate` 的选项：id 与 manifest 措辞、骨架目录 */
export interface StyleValidateOptions {
  /** 模板 id（脚本用 manifest 的 id）；缺省取 stylemap 的 name */
  id?: string
  /** manifest 里的 stylemap_file（含 .json），同时用来推导与结构模板配对的 key */
  stylemapFile?: string
  /** `styles/<id>` 目录绝对路径；不给就跳过所有需要骨架的检查（骨架部件、styleId、起始编号） */
  basePath?: string
  /** manifest 里的 style_folder，用于报"manifest 与 stylemap 的 docxFolder 不一致" */
  manifestStyleFolder?: string
}

// ================= 取值工具 =================

/** 把任意 JSON 值按 JS 插值语义转成文案（与脚本的模板字符串一致：undefined → "undefined"） */
function text(value: unknown): string {
  return String(value)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * 取数组字段：脚本写的是 `node.children ?? []`，字段不是数组时它会抛错，
 * 这里按"不是数组就是空"处理（加载器 manager.ts 的 asArray 也是这个口径），
 * 唯一的效果是坏模板不再把校验器打崩，判定条件本身没变。
 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 读文本文件，读不到（不存在 / 读失败）返回 null */
function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 与脚本 `${where}` 同法：trail 为空串时显示 (root) */
function whereOf(trail: string): string {
  return trail || '(root)'
}

/** 拼路径标签，统一用 `/`（Windows 上也照样显示得清楚） */
function label(...parts: string[]): string {
  return parts.join('/')
}

// ================= 骨架索引 =================

/** `<w:style ...>` 元素（含自闭合形式） */
const STYLE_ELEMENT_RE = /<w:style\b([^>]*?)(?:\/>|>([\s\S]*?)<\/w:style>)/gu

/** 取 `name="value"` 形式的属性值 */
function attrValue(attrs: string, name: string): string | undefined {
  const m = new RegExp(`${name}="([^"]*)"`, 'u').exec(attrs)
  return m ? m[1] : undefined
}

/**
 * 从骨架 styles.xml 抽全部 `w:styleId` 值。
 * **与脚本和 manager.ts 同法**：按字面匹配 `styleId="..."`，不做 XML 解析
 * （解析器对 <w:style> 之外的 styleId 引用行为不一致，三处必须同法）。
 */
function collectStyleIds(xml: string | null): string[] {
  const ids: string[] = []
  if (xml === null) return ids
  const seen = new Set<string>()
  for (const m of xml.matchAll(/styleId="([^"]+)"/gu)) {
    const id = m[1]
    if (id !== undefined && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

/** 从骨架 styles.xml 解析可读样式表（给编辑模式的对照表用；判定仍走 collectStyleIds） */
function parseStyleElements(xml: string | null): SkeletonStyleInfo[] {
  const out: SkeletonStyleInfo[] = []
  if (xml === null) return out
  for (const m of xml.matchAll(STYLE_ELEMENT_RE)) {
    const attrs = m[1] ?? ''
    const styleId = attrValue(attrs, 'w:styleId')
    if (styleId === undefined) continue
    const body = m[2] ?? ''
    const info: SkeletonStyleInfo = {
      styleId,
      name: attrValue(/<w:name\b[^>]*>/u.exec(body)?.[0] ?? '', 'w:val') ?? '',
      type: attrValue(attrs, 'w:type') ?? '',
      isDefault: attrValue(attrs, 'w:default') === '1'
    }
    const basedOn = attrValue(/<w:basedOn\b[^>]*>/u.exec(body)?.[0] ?? '', 'w:val')
    if (basedOn !== undefined) info.basedOn = basedOn
    // 字号：w:sz 的单位是半磅（24 = 12pt）
    const sz = /<w:sz w:val="(\d+)"/u.exec(body)
    if (sz?.[1] !== undefined) {
      const half = Number(sz[1])
      info.fontSizeHalfPoints = half
      info.fontSizePt = half / 2
    }
    out.push(info)
  }
  return out
}

/**
 * 读骨架 numbering.xml 第一个 abstractNum 的各层起始编号。
 * **照抄脚本**：只认第一个 `abstractNum`、`<w:lvl ...>` 必须成对闭合、
 * 只认 `<w:start w:val="..."/>`；读不到返回 `undefined`（脚本返回 null）。
 * 程序算题注章节号读的就是这个（manager.ts 的 parseHeadingStarts 同法）。
 */
function collectHeadingStarts(xml: string | null): number[] | undefined {
  if (xml === null) return undefined
  const abstract = /<w:abstractNum[\s\S]*?<\/w:abstractNum>/.exec(xml)
  if (!abstract) return undefined
  const starts: number[] = []
  for (const m of abstract[0].matchAll(/<w:lvl [^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
    const ilvl = Number(m[1])
    const start = /<w:start w:val="(\d+)"/.exec(m[2] ?? '')
    if (start) starts[ilvl] = Number(start[1])
  }
  return starts.length > 0 ? starts : undefined
}

/**
 * 骨架索引：读 `word/styles.xml` 与 `word/numbering.xml`，给出
 * 可用样式表（styleId、样式名、段落或字符、字号）与各级标题起始号。
 * 部件缺失不抛错：读不到就是空表 / `headingStarts: undefined`，
 * 由 `validateStyleTemplate` 负责报「缺部件」。
 */
export function parseSkeletonIndex(skeletonPath: string): SkeletonIndex {
  const stylesXml = readTextOrNull(join(skeletonPath, 'word', 'styles.xml'))
  const numberingXml = readTextOrNull(join(skeletonPath, 'word', 'numbering.xml'))
  return {
    skeletonPath,
    styleIds: collectStyleIds(stylesXml),
    styles: parseStyleElements(stylesXml),
    headingStarts: collectHeadingStarts(numberingXml)
  }
}

// ================= 逻辑样式键推导 =================

/**
 * 结构节点定义 → 所需逻辑样式键（脚本 `requiredStyleKeys` 的照抄版，保留插入顺序）。
 *
 * 判定条件（与脚本逐条对齐，勿改）：
 * - 子标题节点（nodeType `subTitle` / `subtitle`）：`subtitle.1 .. subtitle.<嵌套深度>`；
 * - 非子标题且 `headingLevel > 0`：`heading.<headingLevel>`；
 * - text / formula / code → `body`；image / mermaid → `body` + `figure.caption`；
 *   table → `table.caption` + `table.header` + `table.body`；
 *   orderedList → `list.ordered.1`；unorderedList → `list.unordered.1`；
 *   认不出的块类型不产生键。
 *
 * 注意列表：脚本**只推导到第 1 层**（`list.*.1`），没有"用到第几层就要到第几层"的逻辑；
 * 样式侧还专门有一条"list.*.2/3 程序不读"的告警，与之一致。本实现照抄。
 */
function collectStyleKeys(node: unknown, subDepth = 0, keys = new Set<string>()): Set<string> {
  const obj = asObject(node)
  if (!obj) return keys
  const nodeType = obj['nodeType']
  const isSub = nodeType === 'subTitle' || nodeType === 'subtitle'
  if (isSub) {
    for (let d = 1; d <= subDepth + 1; d++) keys.add(`subtitle.${d}`)
  } else if (Number(obj['headingLevel'] ?? 1) > 0) {
    keys.add(`heading.${Number(obj['headingLevel'] ?? 1)}`)
  }
  for (const raw of asArray(obj['contentBlocks'])) {
    const b = asObject(raw)
    if (!b) continue
    switch (b['type']) {
      case 'text':
      case 'formula':
      case 'code':
        keys.add('body')
        break
      case 'image':
      case 'mermaid':
        keys.add('body')
        keys.add('figure.caption')
        break
      case 'table':
        keys.add('table.caption')
        keys.add('table.header')
        keys.add('table.body')
        break
      case 'orderedList':
        keys.add('list.ordered.1')
        break
      case 'unorderedList':
        keys.add('list.unordered.1')
        break
      default:
        break
    }
  }
  for (const child of childrenOf(obj)) {
    collectStyleKeys(child, isSub ? subDepth + 1 : 0, keys)
  }
  return keys
}

/**
 * 取子节点：结构 JSON 原文用 `children`，加载器解析后的节点定义用 `defaultChildren`。
 * 两种输入都接受，让本模块既能判原文（含 padlock 之类的"写了但不生效"），
 * 也能直接被已有调用方拿 TemplateDef 调。
 */
function childrenOf(node: Record<string, unknown>): unknown[] {
  if (Array.isArray(node['children'])) return node['children']
  if (Array.isArray(node['defaultChildren'])) return node['defaultChildren']
  return []
}

/** 结构模板输入 → 根节点对象：结构 JSON 原文（root）/ 加载后的 TemplateDef（rootDef）/ 裸节点 */
function rootNodeOf(input: unknown): Record<string, unknown> | null {
  const obj = asObject(input)
  if (!obj) return null
  const root = obj['root'] ?? obj['rootDef']
  if (root !== undefined) return asObject(root)
  // 裸节点：带 nodeType / contentBlocks / children 的结构节点定义
  return obj
}

/**
 * 按结构模板**实际用到的块**推导必需逻辑样式键，返回**排序后**的数组
 * （与 `manager.ts` 的 `requiredStyleKeys` 同形，方便直接对比与展示）。
 *
 * 入参可以是结构 JSON 原文（`{ name, root }`）、加载器解析后的 `TemplateDef`
 * （`{ rootDef }`），或一份裸节点定义。
 */
export function requiredStyleKeys(structureDef: unknown): string[] {
  const root = rootNodeOf(structureDef)
  if (!root) return []
  return [...collectStyleKeys(root)].sort()
}

// ================= 题注收集 =================

/** 结构里的题注（表题 / 图题），用于核对与题注编号模式是否打架（脚本 collectCaptions 照抄） */
function collectCaptions(
  node: unknown,
  out: Array<{ kind: 'table' | 'figure'; text: string }> = []
): Array<{ kind: 'table' | 'figure'; text: string }> {
  const obj = asObject(node)
  if (!obj) return out
  for (const raw of asArray(obj['contentBlocks'])) {
    const b = asObject(raw)
    if (!b || !b['caption']) continue
    if (b['type'] === 'table') out.push({ kind: 'table', text: text(b['caption']) })
    else if (b['type'] === 'image' || b['type'] === 'mermaid') {
      out.push({ kind: 'figure', text: text(b['caption']) })
    }
  }
  for (const child of childrenOf(obj)) collectCaptions(child, out)
  return out
}

// ================= 结构模板校验 =================

/**
 * 校验结构模板（对应脚本 checkStructure + checkStructureNode + 复制组检查）。
 *
 * 只做**单份模板**能判的事：文件级字段（name / root / styleTemplate / manifest 名字不一致）
 * 与整棵节点树的节点开关、内容块字段、表格形状、锁取值、复制组开关。
 * 目录与 manifest 条目的存在性检查在批次 1 的服务层（见文件头说明）。
 */
export function validateStructureTemplate(
  def: unknown,
  opts: StructureValidateOptions = {}
): ValidationIssue[] {
  const out: ValidationIssue[] = []
  const doc = asObject(def) ?? {}
  const id = opts.id !== undefined && opts.id !== '' ? opts.id : text(doc['name'] ?? '') || '(未命名)'
  const fileLabel = opts.file ? label('structures', id, opts.file) : label('structures', id)

  if (!doc['name']) {
    out.push({
      level: 'error',
      rule: 'structure.name.missing',
      path: 'name',
      message: `${fileLabel} 缺顶层 name（缺了整份文件被丢弃）`
    })
  }
  const root = asObject(doc['root'])
  if (!root) {
    out.push({
      level: 'error',
      rule: 'structure.root.missing',
      path: 'root',
      message: `${fileLabel} 缺顶层 root（缺了整份文件被丢弃）`
    })
    return out
  }
  if (opts.manifestName && doc['name'] && opts.manifestName !== doc['name']) {
    out.push({
      level: 'warn',
      rule: 'structure.manifestName.mismatch',
      path: 'manifest.name',
      message:
        `manifest 里 name=「${opts.manifestName}」与结构文件里的 name=「${text(doc['name'])}」不一致；` +
        `程序按结构文件里的 name 注册`
    })
  }
  if (!doc['styleTemplate'] && !Array.isArray(doc['styleTemplates'])) {
    out.push({
      level: 'warn',
      rule: 'structure.styleTemplate.absent',
      path: 'styleTemplate',
      message: `structures/${id}：既没有 styleTemplate 也没有 styleTemplates，这套结构在导出时没有候选样式`
    })
  }

  checkStructureNode(root, '', 'root', id, out)
  checkCopyGroups(root, 'root', out)
  return out
}

/**
 * 递归检查节点与其内容块（脚本 checkStructureNode 照抄）。
 * `trail` 是脚本给作者看的位置串（节点标题拼出来的），`path` 是 JSON 路径。
 */
function checkStructureNode(
  node: Record<string, unknown>,
  trail: string,
  path: string,
  id: string,
  out: ValidationIssue[]
): void {
  const where = whereOf(trail)
  const level = node['headingLevel']

  if (node['title'] === undefined) {
    out.push({
      level: 'warn',
      rule: 'node.title.missing',
      path: `${path}.title`,
      message: `${id}｜节点「${where}」没有 title`
    })
  }
  // lock 是块级字段：写在节点上不生效，节点级仍用 copyable / deletable / allowContentBlocks
  if ('lock' in node) {
    out.push({
      level: 'error',
      rule: 'node.lock.misplaced',
      path: `${path}.lock`,
      message:
        `${id}｜节点「${where}」把 lock 写在了节点上（不生效）——` +
        `块锁写进该节点的 contentBlocks[] 里，节点级用 copyable / deletable / allowContentBlocks`
    })
  }
  if (level !== undefined && (!Number.isInteger(level as number) || (level as number) < 0)) {
    out.push({
      level: 'error',
      rule: 'node.headingLevel.invalid',
      path: `${path}.headingLevel`,
      message: `${id}｜节点「${where}」的 headingLevel 非法：${text(JSON.stringify(level))}`
    })
  }
  if ((level as number) > 9) {
    out.push({
      level: 'warn',
      rule: 'node.headingLevel.deep',
      path: `${path}.headingLevel`,
      message: `${id}｜节点「${where}」的 headingLevel=${text(level)} 超深，Word 多级列表一般到 9 级`
    })
  }

  // copyable/deletable 缺省是 false，漏写会锁死节点
  if (
    node['copyable'] === undefined &&
    node['deletable'] === undefined &&
    node['nodeType'] !== 'root'
  ) {
    out.push({
      level: 'warn',
      rule: 'node.switches.absent',
      path,
      message:
        `${id}｜节点「${where}」未写 copyable/deletable，缺省都是 false（既不能复制也不能删除），确认是否有意为之`
    })
  }
  // 脚本在这里有一个空判断（deletable === true 且没有 children 属正常），不产生结论，故不搬

  // 内容块
  const blocks = asArray(node['contentBlocks'])
  for (let i = 0; i < blocks.length; i++) {
    const b = asObject(blocks[i])
    const bw = `${id}｜节点「${where}」第 ${i + 1} 个内容块`
    const bp = `${path}.contentBlocks[${i}]`
    if (!b) {
      // 脚本在这里会因为读不到 b.type 而崩；坏模板按"未知类型"报一条，不再往下判
      out.push({
        level: 'error',
        rule: 'block.type.unknown',
        path: `${bp}.type`,
        message: `${bw}：未知 type=${text(JSON.stringify(undefined))}（程序会丢弃这一块）`
      })
      continue
    }
    if (!(KNOWN_BLOCK_TYPES as readonly string[]).includes(text(b['type']))) {
      out.push({
        level: 'error',
        rule: 'block.type.unknown',
        path: `${bp}.type`,
        message: `${bw}：未知 type=${text(JSON.stringify(b['type']))}（程序会丢弃这一块）`
      })
      continue
    }
    if (b['description'] !== undefined) {
      out.push({
        level: 'warn',
        rule: 'block.description.unread',
        path: `${bp}.description`,
        message: `${bw}：内容块上的 description 程序不读，提示到不了用户眼前；请把提示上提到节点的 description`
      })
    }
    // 块锁（PLAN-09）：只认 type / keep / readonly 三档，其它值程序按不锁处理并记警告
    if (b['lock'] !== undefined && !(LOCK_TIERS as readonly string[]).includes(text(b['lock']))) {
      out.push({
        level: 'error',
        rule: 'block.lock.invalid',
        path: `${bp}.lock`,
        message:
          `${bw}：lock 取值 ${text(JSON.stringify(b['lock']))} 不在 ${LOCK_TIERS.map(
            (x) => `"${x}"`
          ).join(' / ')} 之内` + `（程序按不锁处理：这一块会被当成普通块，锁白加了）`
      })
    }
    // 反向也别混：节点级字段写到块上程序不读
    for (const k of [
      'copyable',
      'deletable',
      'allowContentBlocks',
      'headingLevel',
      'title',
      'children'
    ]) {
      if (k in b) {
        out.push({
          level: 'error',
          rule: 'block.nodeField.misplaced',
          path: `${bp}.${k}`,
          message: `${bw}：块上写了节点级字段 ${k}（程序不读；节点级字段写在该节点上，块锁用 lock）`
        })
      }
    }
    if (b['type'] === 'text' && typeof b['content'] !== 'string') {
      out.push({
        level: 'error',
        rule: 'block.text.content',
        path: `${bp}.content`,
        message: `${bw}：text 必须给 content 字符串`
      })
    }
    if (
      (b['type'] === 'orderedList' || b['type'] === 'unorderedList') &&
      !Array.isArray(b['items'])
    ) {
      out.push({
        level: 'error',
        rule: 'block.list.items',
        path: `${bp}.items`,
        message: `${bw}：${text(b['type'])} 必须给 items 字符串数组`
      })
    }
    if (b['type'] === 'image') {
      if (typeof b['content'] !== 'string') {
        out.push({
          level: 'error',
          rule: 'block.image.content',
          path: `${bp}.content`,
          message: `${bw}：image 必须给 content（工程内相对路径，可为空串）`
        })
      }
      if (!b['caption']) {
        out.push({
          level: 'warn',
          rule: 'block.image.caption',
          path: `${bp}.caption`,
          message: `${bw}：image 没有 caption，导出后不会有图题`
        })
      }
    }
    if (b['type'] === 'mermaid') {
      if (!b['content']) {
        out.push({
          level: 'error',
          rule: 'block.mermaid.content',
          path: `${bp}.content`,
          message: `${bw}：mermaid 必须给 content（Mermaid 源码）`
        })
      }
      if (!b['caption']) {
        out.push({
          level: 'warn',
          rule: 'block.mermaid.caption',
          path: `${bp}.caption`,
          message: `${bw}：mermaid 没有 caption，导出后不会有图题`
        })
      }
    }
    if (b['type'] === 'code' && typeof b['content'] !== 'string') {
      out.push({
        level: 'error',
        rule: 'block.code.content',
        path: `${bp}.content`,
        message: `${bw}：code 必须给 content`
      })
    }

    if (b['type'] === 'table') checkTableBlock(b, bw, bp, out)
  }

  const children = asArray(node['children'])
  for (let i = 0; i < children.length; i++) {
    const child = asObject(children[i])
    if (!child) continue
    const childTrail = `${trail}/${text(node['title'] ?? '?')}`
    checkStructureNode(child, childTrail, `${path}.children[${i}]`, id, out)
  }
}

/** 表格块的形状检查（脚本 checkStructureNode 里 `if (b.type === 'table')` 那段照抄） */
function checkTableBlock(
  b: Record<string, unknown>,
  bw: string,
  bp: string,
  out: ValidationIssue[]
): void {
  const cols = Number(b['cols'])
  if (!Number.isInteger(cols) || cols <= 0) {
    out.push({
      level: 'error',
      rule: 'block.table.cols',
      path: `${bp}.cols`,
      message: `${bw}：cols 非法：${text(JSON.stringify(b['cols']))}`
    })
  }
  if (!Array.isArray(b['headers'])) {
    out.push({
      level: 'error',
      rule: 'block.table.headers',
      path: `${bp}.headers`,
      message: `${bw}：headers 必须是字符串数组`
    })
  } else if (b['headers'].length !== cols) {
    out.push({
      level: 'error',
      rule: 'block.table.headers.length',
      path: `${bp}.headers`,
      message: `${bw}：headers 长度 ${b['headers'].length} ≠ cols ${cols}`
    })
  }
  if (!Array.isArray(b['data'])) {
    out.push({
      level: 'error',
      rule: 'block.table.data',
      path: `${bp}.data`,
      message: `${bw}：data 必须是二维字符串数组`
    })
  } else {
    const data = b['data']
    const badRows = data.filter((r) => !Array.isArray(r))
    if (badRows.length > 0) {
      out.push({
        level: 'error',
        rule: 'block.table.data.rowNotArray',
        path: `${bp}.data`,
        message:
          `${bw}：data 有 ${badRows.length}/${data.length} 行不是数组，例：` +
          `${text(JSON.stringify(badRows[0]))}`
      })
    } else {
      const wrong = data.filter((r) => (r as unknown[]).length !== cols)
      if (wrong.length > 0) {
        out.push({
          level: 'error',
          rule: 'block.table.data.rowLength',
          path: `${bp}.data`,
          message:
            `${bw}：data 有 ${wrong.length} 行的列数 ≠ cols ${cols}，例：` +
            `${text(JSON.stringify(wrong[0])).slice(0, 60)}`
        })
      }
      // 两种口径都接受：rows = 正文行数（推荐），或 rows = 正文行数 + 1（把表头算进去）。
      // 其余情况渲染会取 min(rows, data.length)，多出的行不显示、写多的 data 行被丢掉。
      const declared = Number(b['rows'])
      if (declared !== data.length && declared !== data.length + 1) {
        out.push({
          level: 'warn',
          rule: 'block.table.rows',
          path: `${bp}.rows`,
          message:
            `${bw}：rows=${text(b['rows'])} 既不是正文行数 ${data.length}，也不是"含表头"的 ` +
            `${data.length + 1}；渲染取 min(rows, data.length)，多出的行不会显示`
        })
      }
    }
  }
  if (b['mergeVertical'] === true && Array.isArray(b['data'])) {
    // 实测依据：脚本注释说程序 parseNodeDef 只拷
    // type/caption/content/language/rows/cols/headers/data/items，漏了 mergeVertical。
    // 注意：这条依据在当前程序侧**已经过期**（manager.ts 的 parseNodeDef 与
    // templateBlockOfDef 都带上了 mergeVertical，PLAN-06 已落地），但脚本没删这条告警，
    // 批次 0 的口径是"与脚本一致"，所以照搬，未顺手改判。见报告"未做或不确定的地方"。
    out.push({
      level: 'warn',
      rule: 'block.table.mergeVertical.unread',
      path: `${bp}.mergeVertical`,
      message:
        `${bw}：开了 mergeVertical，但模板里的该字段目前不会被程序读进工程` +
        `（新建工程的表格不会合并，依据见 docs/06-常见问题与排错.md 第 8 节）`
    })
    const data = b['data']
    const flat = data.flat()
    const filled = flat.filter((c) => typeof c === 'string' && c.trim() !== '').length
    if (filled === 0) {
      out.push({
        level: 'warn',
        rule: 'block.table.mergeVertical.empty',
        path: `${bp}.data`,
        message:
          `${bw}：data 全是空串——即使合并开关生效也不会合并；想在模板里演示，` +
          `需在相邻行的同一列填相同的非空值`
      })
    }
  }
}

/**
 * 复制组检查（脚本 walkGroups 照抄）：只判"有 copyGroupId 但 copyable 不是 true"。
 * 复制组的份数统计在脚本里是事实陈述，不是问题，故不产出结论。
 */
function checkCopyGroups(
  node: Record<string, unknown>,
  path: string,
  out: ValidationIssue[]
): void {
  const children = asArray(node['children'])
  for (let i = 0; i < children.length; i++) {
    const c = asObject(children[i])
    if (!c) continue
    const childPath = `${path}.children[${i}]`
    if (c['copyGroupId']) {
      if (c['copyable'] !== true) {
        out.push({
          level: 'warn',
          rule: 'node.copyGroup.notCopyable',
          path: `${childPath}.copyable`,
          message:
            `节点「${text(c['title'])}」有 copyGroupId=${text(c['copyGroupId'])} 但 copyable 不是 true，` +
            `用户复制不了它`
        })
      }
    }
    checkCopyGroups(c, childPath, out)
  }
}

// ================= 样式模板校验 =================

/**
 * 校验样式模板（对应脚本 checkStyle）。
 *
 * @param styleDef stylemap JSON 原文（`{ name, styleMap, docxFolder, captionNumbering }`）
 * @param structureDefs 结构模板 JSON 原文列表，用于"结构需要的逻辑键样式有没有覆盖"与题注口径比对；
 *   只比对 `styleTemplate` 等于本 stylemap 文件名的那些结构（与脚本同法）
 * @param opts `id`（消息前缀）、`stylemapFile`（manifest 里的文件名，同时用来推导配对 key）、
 *   `basePath`（`styles/<id>` 目录；不给就跳过需要骨架的检查）、`manifestStyleFolder`
 */
export function validateStyleTemplate(
  styleDef: unknown,
  structureDefs: readonly unknown[] = [],
  opts: StyleValidateOptions = {}
): ValidationIssue[] {
  const out: ValidationIssue[] = []
  const doc = asObject(styleDef) ?? {}
  const id = opts.id !== undefined && opts.id !== '' ? opts.id : text(doc['name'] ?? '') || '(未命名)'
  const stylemapLabel = opts.stylemapFile
    ? label('styles', id, opts.stylemapFile)
    : label('styles', id)

  if (!doc['name']) {
    out.push({
      level: 'error',
      rule: 'style.name.missing',
      path: 'name',
      message: `${stylemapLabel} 缺顶层 name（缺了整份被丢弃）`
    })
  }
  const styleMap = asObject(doc['styleMap'])
  if (!styleMap) {
    out.push({
      level: 'error',
      rule: 'style.styleMap.missing',
      path: 'styleMap',
      message: `${stylemapLabel} 缺顶层 styleMap（缺了整份被丢弃）`
    })
    return out
  }
  const docxFolder = doc['docxFolder']
  if (!docxFolder) {
    out.push({
      level: 'error',
      rule: 'style.docxFolder.missing',
      path: 'docxFolder',
      message: `styles/${id}：stylemap 缺 docxFolder，程序找不到骨架目录`
    })
    return out
  }
  if (opts.manifestStyleFolder && opts.manifestStyleFolder !== docxFolder) {
    out.push({
      level: 'warn',
      rule: 'style.manifestStyleFolder.mismatch',
      path: 'manifest.style_folder',
      message:
        `manifest 的 style_folder=「${opts.manifestStyleFolder}」与 stylemap 的 docxFolder=` +
        `「${text(docxFolder)}」不一致；程序实际用 docxFolder`
    })
  }

  // 骨架：没有 basePath 就没有骨架可查（编辑模式早期只改映射表时会走这条）
  if (opts.basePath) {
    const skeletonPath = join(opts.basePath, text(docxFolder))
    if (!existsSync(skeletonPath)) {
      out.push({
        level: 'error',
        rule: 'style.skeleton.missing',
        path: label('skeleton', text(docxFolder)),
        message: `styles/${id}/${text(docxFolder)} 骨架目录不存在`
      })
      return out
    }
    for (const part of SKELETON_REQUIRED_PARTS) {
      if (!existsSync(join(skeletonPath, part))) {
        out.push({
          level: 'error',
          rule: 'style.skeleton.part',
          path: label('skeleton', part),
          message: `styles/${id}/${text(docxFolder)} 缺部件 ${part}`
        })
      }
    }

    const index = parseSkeletonIndex(skeletonPath)
    if (index.styleIds.length === 0) {
      out.push({
        level: 'error',
        rule: 'style.skeleton.styleId.none',
        path: 'skeleton/word/styles.xml',
        message: `styles/${id}/${text(docxFolder)}/word/styles.xml 读不到任何 styleId`
      })
    } else {
      const validIds = new Set(index.styleIds)
      for (const [logical, styleId] of Object.entries(styleMap)) {
        if (!validIds.has(String(styleId))) {
          out.push({
            level: 'error',
            rule: 'style.styleMap.styleId.missing',
            path: `styleMap['${logical}']`,
            message:
              `styles/${id}：styleMap 的 ${logical}=${text(JSON.stringify(styleId))} ` +
              `在骨架 styles.xml 里不存在（该处会按默认样式输出）`
          })
        }
      }
    }

    const starts = index.headingStarts
    if (!starts) {
      out.push({
        level: 'warn',
        rule: 'style.skeleton.headingStarts',
        path: 'skeleton/word/numbering.xml',
        message:
          `styles/${id}：读不到骨架 numbering.xml 的 abstractNum 起始编号，` +
          `题注章节号会从 1 起算`
      })
    }
    // 起始编号不是 1 在脚本里是事实陈述（有意的模板设计），不产出结论
  }

  const cn = doc['captionNumbering']
  const cnObj = asObject(cn)
  if (cnObj) {
    for (const kind of ['table', 'figure'] as const) {
      const mode = cnObj[kind]
      if (mode !== undefined && !(CAPTION_MODES as readonly string[]).includes(text(mode))) {
        out.push({
          level: 'error',
          rule: 'style.captionNumbering.mode',
          path: `captionNumbering.${kind}`,
          message:
            `styles/${id}：captionNumbering.${kind}=${text(JSON.stringify(mode))} ` +
            `不是 auto/static/field`
        })
      }
    }
    if (cnObj['table'] === 'field' || cnObj['figure'] === 'field') {
      const names = asObject(cnObj['chapterStyleNames'])
      if (!names || Object.keys(names).length === 0) {
        out.push({
          level: 'warn',
          rule: 'style.captionNumbering.chapterStyleNames',
          path: 'captionNumbering.chapterStyleNames',
          message:
            `styles/${id}：题注用 field 模式但没配 chapterStyleNames，` +
            `程序按中文惯例用「标题 N」，英文版 Word 打开会算不出章节号`
        })
      }
    }
  } else {
    out.push({
      level: 'warn',
      rule: 'style.captionNumbering.absent',
      path: 'captionNumbering',
      message:
        `styles/${id}：没有 captionNumbering，题注按 auto 处理` +
        `（手写"表N"前缀会被剥掉，序号交给样式多级列表）`
    })
  }

  // 与配对结构比对逻辑键覆盖
  const fileKey =
    opts.stylemapFile !== undefined ? opts.stylemapFile.replace(/\.json$/u, '') : undefined
  for (const rawStructure of structureDefs) {
    const st = asObject(rawStructure)
    if (!st) continue
    const root = asObject(st['root'])
    if (!root) continue // 脚本里结构整份没加载时不参与比对
    if (fileKey === undefined) continue
    if (text(st['styleTemplate'] ?? '') !== fileKey) continue
    const stName = text(st['name'] ?? '')
    const keys = collectStyleKeys(root)
    const missing = [...keys].filter((k) => !(k in styleMap))
    if (missing.length > 0) {
      out.push({
        level: 'error',
        rule: 'style.structure.keysMissing',
        path: `structure[${stName}].styleMap`,
        message:
          `样式 ${id} 没有覆盖结构「${stName}」需要的逻辑键：${missing.join(' / ')}` +
          `（这些位置会按默认样式输出）`
      })
    }
    // 题注手写号：auto / field 模式下程序只剥「表/图 + 数字」，写成「表【N】」「表 名称」这类
    // 不会被剥，导出时会和自动编号重复（static 模式原样保留，不在检查范围）
    const capMode = {
      table: text(cnObj?.['table'] ?? 'auto'),
      figure: text(cnObj?.['figure'] ?? 'auto')
    }
    const captions = collectCaptions(root)
    for (let i = 0; i < captions.length; i++) {
      const cap = captions[i]!
      if (capMode[cap.kind] === 'static') continue
      if (/^(表|图)\s*【/u.test(cap.text) || /^(表|图)[ \u3000]/u.test(cap.text)) {
        out.push({
          level: 'warn',
          rule: 'style.caption.handwritten',
          path: `structure[${stName}].captions[${i}]`,
          message:
            `样式 ${id}：结构「${stName}」的题注「${cap.text.slice(0, 28)}…」以「表/图」开头` +
            `但不是「表+数字」，程序不会剥离，会与自动编号重复——题注只写名称，号交给题注域`
        })
      }
    }
    // figure 是可选键：结构里有图但样式没配 figure，只是提示
    if (keys.has('figure.caption') && !('figure' in styleMap)) {
      out.push({
        level: 'warn',
        rule: 'style.figure.absent',
        path: 'styleMap.figure',
        message: `样式 ${id} 没配可选的 figure 键，图片段落会回退成 body 样式`
      })
    }
    // 用不到的高阶列表键
    for (const k of UNREAD_LIST_KEYS) {
      if (k in styleMap) {
        out.push({
          level: 'warn',
          rule: 'style.listKey.unread',
          path: `styleMap['${k}']`,
          message: `样式 ${id}：${k} 程序不读，配了不生效`
        })
      }
    }
  }

  return out
}
