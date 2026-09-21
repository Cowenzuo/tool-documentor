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
 * 四件事：
 *   1. `parseSkeletonIndex(skeletonPath)`：读骨架 styles.xml / numbering.xml，给出可读样式表
 *      （styleId、样式名、段落或字符、字号）与各级标题起始号；
 *   2. `requiredStyleKeys(structureDef)`：按结构模板**实际用到的块**推导必需逻辑样式键；
 *   3. `validateStructureTemplate` / `validateStyleTemplate`：产出
 *      `{ level, path, message }` 列表，`path` 指到具体节点或字段
 *      （如 `root.children[2].contentBlocks[0].lock`）；
 *   4. `validateTemplateDir(dir)`：目录级校验（批次 1），把脚本里"要读模板目录与清单才知道"
 *      的那批规则补齐——manifest 缺失或解析失败、条目缺 id/file、目录与文件不存在、
 *      JSON 解析失败、目录没登记、模板名重复、"结构声明的样式没有 manifest 条目"。
 *      它同时按 manifest 逐份跑上面两个单份校验，产出可直接给界面用的模板列表。
 *
 * 输入一律是**模板 JSON 原文**（`JSON.parse` 的结果），不是加载器解析后的
 * `TemplateDef`：脚本判的是原文（节点上有没有写 lock、headingLevel 是不是整数、
 * 块上有没有多写节点级字段），这些信息在解析成 TemplateDef 时就丢了。
 *
 * 目录级规则（批次 1 的 `validateTemplateDir`）与单份模板规则共用同一份文案：
 * 每条 message 仍是 `check-templates.cjs` 里的原句（脚本输出前缀 `[check-templates] ✗` 除外），
 * `path` 是产品侧新增的结构化位置（`structures/<id>/<file>`、`manifest.structures[0]` 这类）。
 * 脚本里读目录的那几处（`checkStructure` / `checkStyle` / 主流程）与本模块一一对应，
 * 只有两处产品侧口径不同、都写在 `validateTemplateDir` 的注释里：
 * 脚本遇到目录不存在或坏 manifest 会 `process.exit`/抛错，本模块一律返回结论不崩。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BlockLockLevel } from '@documentor/core'
import { validateStyleMap } from './style-rules'
import type { SkeletonFacts, StyleStructureFacts } from './style-rules'

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
export const SKELETON_REQUIRED_PARTS = [
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
  /**
   * 这条样式自己带不带自动编号：`w:numPr` 里给了非 0 的 `w:numId` 就是带
   * （`w:numId="0"` 是 OOXML 里"取消编号"的写法，不算带）。
   * 判题注靠的是它：auto 模式的号就来自样式多级列表，样式没带号时 auto 出不来号。
   */
  numbered?: boolean
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
    // 自动编号：w:numPr 里的 w:numId 非 0 才算带（0 是"取消编号"）
    const numPr = /<w:numPr>([\s\S]*?)<\/w:numPr>/u.exec(body)
    if (numPr) {
      const numId = attrValue(/<w:numId\b[^>]*>/u.exec(numPr[1] ?? '')?.[0] ?? '', 'w:val')
      info.numbered = numId !== undefined && numId !== '0'
    }
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
 * - 列表子标题节点（nodeType `subTitle` / `subtitle`）：`subtitle.1 .. subtitle.<嵌套深度>`；
 * - 非列表子标题且 `headingLevel > 0`：`heading.<headingLevel>`；
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
      message: `节点 ${where} · 缺 title`
    })
  }
  // lock 是块级字段：写在节点上不生效，节点级仍用 copyable / deletable / allowContentBlocks
  if ('lock' in node) {
    out.push({
      level: 'error',
      rule: 'node.lock.misplaced',
      path: `${path}.lock`,
      message: `节点 ${where} · lock 不生效（块锁写在 contentBlocks[] 里）`
    })
  }
  if (level !== undefined && (!Number.isInteger(level as number) || (level as number) < 0)) {
    out.push({
      level: 'error',
      rule: 'node.headingLevel.invalid',
      path: `${path}.headingLevel`,
      message: `节点 ${where} · headingLevel 非法：${text(JSON.stringify(level))}`
    })
  }
  if ((level as number) > 9) {
    out.push({
      level: 'warn',
      rule: 'node.headingLevel.deep',
      path: `${path}.headingLevel`,
      message: `节点 ${where} · headingLevel ${text(level)} 超出 9 级上限`
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
      message: `节点 ${where} · 未写 copyable / deletable · 缺省 false`
    })
  }
  // 脚本在这里有一个空判断（deletable === true 且没有 children 属正常），不产生结论，故不搬

  // 内容块
  const blocks = asArray(node['contentBlocks'])
  for (let i = 0; i < blocks.length; i++) {
    const b = asObject(blocks[i])
    const bw = `${where} › 第 ${i + 1} 块`
    const bp = `${path}.contentBlocks[${i}]`
    if (!b) {
      // 脚本在这里会因为读不到 b.type 而崩；坏模板按"未知类型"报一条，不再往下判
      out.push({
        level: 'error',
        rule: 'block.type.unknown',
        path: `${bp}.type`,
        message: `${bw} · type 未知：${text(JSON.stringify(undefined))} · 该块会被丢弃`
      })
      continue
    }
    if (!(KNOWN_BLOCK_TYPES as readonly string[]).includes(text(b['type']))) {
      out.push({
        level: 'error',
        rule: 'block.type.unknown',
        path: `${bp}.type`,
        message: `${bw} · type 未知：${text(JSON.stringify(b['type']))} · 该块会被丢弃`
      })
      continue
    }
    if (b['description'] !== undefined) {
      out.push({
        level: 'warn',
        rule: 'block.description.unread',
        path: `${bp}.description`,
        message: `${bw} · description 写在块上不读取 · 说明应写在节点上`
      })
    }
    // 块锁（PLAN-09）：只认 type / keep / readonly 三档，其它值程序按不锁处理并记警告
    if (b['lock'] !== undefined && !(LOCK_TIERS as readonly string[]).includes(text(b['lock']))) {
      out.push({
        level: 'error',
        rule: 'block.lock.invalid',
        path: `${bp}.lock`,
        message:
          `${bw} · lock 取值 ${text(JSON.stringify(b['lock']))} 不属于 ` +
          `${LOCK_TIERS.map((x) => `"${x}"`).join(' / ')} · 按不锁处理`
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
          message: `${bw} · ${k} 是节点级字段 · 块上不读取`
        })
      }
    }
    if (b['type'] === 'text' && typeof b['content'] !== 'string') {
      out.push({
        level: 'error',
        rule: 'block.text.content',
        path: `${bp}.content`,
        message: `${bw} · text 缺 content（字符串）`
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
        message: `${bw} · ${text(b['type'])} 缺 items（字符串数组）`
      })
    }
    if (b['type'] === 'image') {
      if (typeof b['content'] !== 'string') {
        out.push({
          level: 'error',
          rule: 'block.image.content',
          path: `${bp}.content`,
          message: `${bw} · image 缺 content（工程内相对路径，可为空）`
        })
      }
      if (!b['caption']) {
        out.push({
          level: 'warn',
          rule: 'block.image.caption',
          path: `${bp}.caption`,
          message: `${bw} · 无 caption · 导出无图题`
        })
      }
    }
    if (b['type'] === 'mermaid') {
      if (!b['content']) {
        out.push({
          level: 'error',
          rule: 'block.mermaid.content',
          path: `${bp}.content`,
          message: `${bw} · mermaid 缺 content（流程图源码）`
        })
      }
      if (!b['caption']) {
        out.push({
          level: 'warn',
          rule: 'block.mermaid.caption',
          path: `${bp}.caption`,
          message: `${bw} · 无 caption · 导出无图题`
        })
      }
    }
    if (b['type'] === 'code' && typeof b['content'] !== 'string') {
      out.push({
        level: 'error',
        rule: 'block.code.content',
        path: `${bp}.content`,
        message: `${bw} · code 缺 content`
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
      message: `${bw} · cols 非法：${text(JSON.stringify(b['cols']))}`
    })
  }
  if (!Array.isArray(b['headers'])) {
    out.push({
      level: 'error',
      rule: 'block.table.headers',
      path: `${bp}.headers`,
      message: `${bw} · headers 需为字符串数组`
    })
  } else if (b['headers'].length !== cols) {
    out.push({
      level: 'error',
      rule: 'block.table.headers.length',
      path: `${bp}.headers`,
      message: `${bw} · headers ${b['headers'].length} 列 ≠ cols ${cols}`
    })
  }
  if (!Array.isArray(b['data'])) {
    out.push({
      level: 'error',
      rule: 'block.table.data',
      path: `${bp}.data`,
      message: `${bw} · data 需为二维字符串数组`
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
          `${bw} · data 有 ${badRows.length}/${data.length} 行不是数组 · 例 ` +
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
            `${bw} · data 有 ${wrong.length} 行列数 ≠ cols ${cols} · 例 ` +
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
            `${bw} · rows=${text(b['rows'])} ≠ 正文行数 ${data.length}，也不是含表头的 ` +
            `${data.length + 1} · 渲染取 min(rows, data.length)`
        })
      }
    }
  }
  if (b['mergeVertical'] === true && Array.isArray(b['data'])) {
    // 曾经这里还有一条"模板里的 mergeVertical 不会被程序读进工程"的告警（脚本的历史遗留）：
    // manager.ts 的 parseNodeDef 与 templateBlockOfDef 都带上了这个字段（PLAN-06 已落地），
    // 新建工程的表格会跟着合并，那句话已经不成立，两边一起删掉。
    // 留下的这条只管"开了开关但 data 全是空串"——程序按内容判定，空串不上合并。
    const data = b['data']
    const flat = data.flat()
    const filled = flat.filter((c) => typeof c === 'string' && c.trim() !== '').length
    if (filled === 0) {
      out.push({
        level: 'warn',
        rule: 'block.table.mergeVertical.empty',
        path: `${bp}.data`,
        message: `${bw} · data 全为空 · 合并不生效`
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
 * 校验样式模板（对应脚本 checkStyle）：**读盘这一层**。
 *
 * 规则本身在 `./style-rules` 的 `validateStyleMap`（不碰 fs，编辑模式在渲染层实时跑同一份）。
 * 这里负责把骨架读成"事实"——目录在不在、缺哪些部件、styleId 有哪些、起始编号是多少——
 * 然后交给那份实现去判。
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
  const doc = asObject(styleDef) ?? {}
  const folder = text(doc['docxFolder'] ?? '')
  let skeleton: SkeletonFacts | undefined
  if (opts.basePath && folder !== '') {
    const skeletonPath = join(opts.basePath, folder)
    const exists = existsSync(skeletonPath)
    const missingParts = exists
      ? SKELETON_REQUIRED_PARTS.filter((part) => !existsSync(join(skeletonPath, part)))
      : []
    const index = exists ? parseSkeletonIndex(skeletonPath) : null
    skeleton = {
      folder,
      exists,
      missingParts: [...missingParts],
      styleIds: index?.styleIds ?? [],
      styles: index?.styles ?? [],
      ...(index?.headingStarts === undefined ? {} : { headingStarts: index.headingStarts })
    }
  }
  return validateStyleMap(styleDef, styleFactsOfStructures(structureDefs), {
    ...(opts.id === undefined ? {} : { id: opts.id }),
    ...(opts.stylemapFile === undefined ? {} : { stylemapFile: opts.stylemapFile }),
    ...(opts.manifestStyleFolder === undefined
      ? {}
      : { manifestStyleFolder: opts.manifestStyleFolder }),
    ...(skeleton === undefined ? {} : { skeleton })
  })
}

/**
 * 结构 JSON 原文 → 样式规则要的"诉求"事实：这份结构引用了哪些样式文件键、
 * 用到哪些逻辑键、有哪些题注。整份没加载的（缺 root）返回 null，与脚本同法。
 */
export function styleFactsOfStructure(doc: unknown): StyleStructureFacts | null {
  const st = asObject(doc)
  if (!st) return null
  const root = asObject(st['root'])
  if (!root) return null
  return {
    name: text(st['name'] ?? ''),
    fileKeys: styleTemplateKeys(st),
    keys: [...collectStyleKeys(root)],
    captions: collectCaptions(root)
  }
}

/** 一批结构模板的诉求事实（编辑模式与主进程都用它，缺 root 的整份跳过） */
export function styleFactsOfStructures(
  structureDefs: readonly unknown[]
): StyleStructureFacts[] {
  const out: StyleStructureFacts[] = []
  for (const raw of structureDefs) {
    const fact = styleFactsOfStructure(raw)
    if (fact) out.push(fact)
  }
  return out
}

// ================= 目录级校验（批次 1） =================

/**
 * 目录里的一份模板：定位信息 + 这一份模板自己的全部结论。
 *
 * `issues` 两层含义合一（界面按它出问题徽标）：
 *   - 这一份的**文件级**结论：目录不存在、文件不存在、JSON 解析失败；
 *   - `validateStructureTemplate` / `validateStyleTemplate` 的逐条结论。
 * 整个目录共有的结论（manifest、目录没登记、重名、样式引用）在 `TemplateDirValidation.issues`，
 * 不重复放进这里；`manifest` 条目本身缺 id/file 时连定位都谈不上，也只能留在目录级。
 */
export interface TemplateDirEntry {
  kind: 'structure' | 'style'
  /** 目录名，也是模板 id */
  id: string
  /** 给人看的名字：模板 JSON 的 name → manifest 的 name → id */
  name: string
  /** manifest 登记的文件名（结构是 file，样式是 stylemap_file） */
  file: string
  issues: ValidationIssue[]
}

/** 一个模板目录的校验结论（供编辑模式与加载报告共用） */
export interface TemplateDirValidation {
  dir: string
  /** 目录本身存不存在；false 时只有一条 `dir.missing` */
  exists: boolean
  /** 目录级结论：manifest、structures//styles/ 目录、登记、重名、样式引用 */
  issues: ValidationIssue[]
  /** manifest 登记且能定位到的结构模板（含读不出来的那些，方便界面显示问题条目） */
  structures: TemplateDirEntry[]
  /** manifest 登记且能定位到的样式模板 */
  styles: TemplateDirEntry[]
}

/** 读 JSON 文件；成功给原文，失败给原因（`Error.message` 或 `String(err)`） */
function readJsonFile(path: string): { doc: unknown } | { error: string } {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
  try {
    return { doc: JSON.parse(raw) as unknown }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** 列一层子目录名（读不到就是空表；脚本在这里会因 readdirSync 抛错而崩） */
function listSubDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** manifest 条目的字段名按加载器（manager.ts）：结构用 file，样式用 stylemap_file */
function entryString(entry: Record<string, unknown> | null, key: string): string {
  const value = entry?.[key]
  return typeof value === 'string' ? value : ''
}

/** 模板名口径与脚本一致：`doc.name ?? entry.name ?? id` */
function nameOfDoc(doc: unknown, fallback: string): string {
  const name = asObject(doc)?.['name']
  return name ? text(name) : fallback
}

/**
 * 结构声明的样式 key 列表（脚本 `st.styleTemplates` 的照抄）：
 * 有 `styleTemplates` 数组就只用它，否则退到单个 `styleTemplate`。
 *
 * 对外也用这个口径回答"这份结构模板引用了哪些样式对照表"（PLAN-11 批次 3 的
 * 共用影响面）：加载器 `TemplateDef.styleTemplates` 同样是"缺省回退为 [styleTemplate]"。
 */
export function styleTemplateKeys(doc: unknown): string[] {
  const obj = asObject(doc)
  if (!obj) return []
  if (Array.isArray(obj['styleTemplates'])) {
    return obj['styleTemplates'].filter((k): k is string => typeof k === 'string' && k !== '')
  }
  return obj['styleTemplate'] ? [text(obj['styleTemplate'])] : []
}

/**
 * 校验一个模板目录（对应脚本 `checkStructure` / `checkStyle` / 主流程里读目录与清单的那部分）。
 *
 * 与脚本同法、逐条照抄：
 *   - manifest 不存在 / 解析失败 → 整个目录只报这一条，不再往下查（脚本这里 `process.exit(1)`）；
 *   - 缺 `structures/` 或 `styles/` 目录各报一条，条目检查照常进行（脚本也照常报"目录不存在"）；
 *   - 条目缺 id/file（样式是 id/stylemap_file）报一条并跳过该条；
 *   - 条目指向的目录、文件不存在，或 JSON 解析失败，各报一条并跳过该条（脚本 `return null`）；
 *   - 读到的结构/样式再走单份模板校验，结论挂到该条目上；
 *   - 反向查目录里没登记的、同名冲突、结构声明的样式 key 没有 manifest 条目。
 *
 * 两处产品侧口径（脚本会崩，本模块不崩）：
 *   - 目录不存在：脚本下一条就是"没有 manifest.json"，这里只报一条 `dir.missing`；
 *   - `manifest.structures/styles` 不是数组：脚本 `.map` 会抛错，这里按空表处理，
 *     于是所有目录都会被报"存在但没登记"，用户能看出是清单写坏了。
 *
 * 结论顺序：manifest → structures//styles/ 目录 → 结构条目（manifest 顺序）→ 样式条目 →
 * 没登记的目录 → 重名 → 样式引用。
 */
export function validateTemplateDir(dir: string): TemplateDirValidation {
  const out: TemplateDirValidation = {
    dir,
    exists: false,
    issues: [],
    structures: [],
    styles: []
  }

  if (!existsSync(dir)) {
    out.issues.push({
      level: 'error',
      rule: 'dir.missing',
      path: dir,
      message: `模板目录不存在：${dir}`
    })
    return out
  }
  out.exists = true

  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    out.issues.push({
      level: 'error',
      rule: 'dir.manifest.missing',
      path: 'manifest.json',
      message: '目录下没有 manifest.json，程序会整个跳过这个模板目录'
    })
    return out
  }
  const manifestRead = readJsonFile(manifestPath)
  if ('error' in manifestRead) {
    out.issues.push({
      level: 'error',
      rule: 'dir.manifest.parse',
      path: 'manifest.json',
      message: `manifest.json 解析失败：${manifestRead.error}（整个目录失效）`
    })
    return out
  }
  const manifest = asObject(manifestRead.doc)
  if (!manifest) {
    out.issues.push({
      level: 'error',
      rule: 'dir.manifest.parse',
      path: 'manifest.json',
      message: 'manifest.json 解析失败：顶层不是对象（整个目录失效）'
    })
    return out
  }

  const structureRoot = join(dir, 'structures')
  const styleRoot = join(dir, 'styles')
  if (!existsSync(structureRoot)) {
    out.issues.push({
      level: 'error',
      rule: 'dir.structuresDir.missing',
      path: 'structures',
      message: '缺少 structures/ 目录（目录名是硬约定）'
    })
  }
  if (!existsSync(styleRoot)) {
    out.issues.push({
      level: 'error',
      rule: 'dir.stylesDir.missing',
      path: 'styles',
      message: '缺少 styles/ 目录（目录名是硬约定）'
    })
  }

  // ---------- 结构条目 ----------
  const rawStructureEntries = asArray(manifest['structures'])
  const declaredStructureIds = new Set<string>()
  /** 读成功的结构原文（样式侧的"必需键覆盖"与题注比对要用） */
  const loadedStructureDocs: unknown[] = []
  /** 读成功的结构（重名与样式引用检查只用它们，与脚本 filter(Boolean) 同法） */
  const loadedStructures: Array<{ id: string; name: string; doc: unknown }> = []

  for (let i = 0; i < rawStructureEntries.length; i++) {
    const raw = rawStructureEntries[i]
    const entry = asObject(raw)
    const id = entryString(entry, 'id')
    const file = entryString(entry, 'file')
    if (!entry || id === '' || file === '') {
      out.issues.push({
        level: 'error',
        rule: 'dir.structureEntry.incomplete',
        path: `manifest.structures[${i}]`,
        message: `manifest.structures 有一条缺 id 或 file：${text(
          JSON.stringify(raw)
        )}（程序会跳过该条）`
      })
      continue
    }
    declaredStructureIds.add(id)

    const manifestName = entryString(entry, 'name')
    const issues: ValidationIssue[] = []
    const item: TemplateDirEntry = {
      kind: 'structure',
      id,
      name: manifestName || id,
      file,
      issues
    }
    out.structures.push(item)

    const itemDir = join(structureRoot, id)
    if (!existsSync(itemDir)) {
      issues.push({
        level: 'error',
        rule: 'structure.dir.missing',
        path: label('structures', id),
        message: `structures/${id} 目录不存在（程序找的是 structures/<id>/<file>）`
      })
      continue
    }
    const filePath = join(itemDir, file)
    if (!existsSync(filePath)) {
      issues.push({
        level: 'error',
        rule: 'structure.file.missing',
        path: label('structures', id, file),
        message: `structures/${id}/${file} 不存在（目录名必须等于 manifest 的 id）`
      })
      continue
    }
    const read = readJsonFile(filePath)
    if ('error' in read) {
      issues.push({
        level: 'error',
        rule: 'structure.file.parse',
        path: label('structures', id, file),
        message: `structures/${id}/${file} JSON 解析失败：${read.error}`
      })
      continue
    }
    issues.push(
      ...validateStructureTemplate(read.doc, {
        id,
        file,
        manifestName: manifestName || undefined
      })
    )
    item.name = nameOfDoc(read.doc, item.name)
    loadedStructureDocs.push(read.doc)
    loadedStructures.push({ id, name: item.name, doc: read.doc })
  }

  // ---------- 样式条目 ----------
  const rawStyleEntries = asArray(manifest['styles'])
  const declaredStyleIds = new Set<string>()
  const declaredStyleKeys = new Set<string>()
  const loadedStyles: Array<{ id: string; name: string }> = []

  for (let i = 0; i < rawStyleEntries.length; i++) {
    const raw = rawStyleEntries[i]
    const entry = asObject(raw)
    const id = entryString(entry, 'id')
    const stylemapFile = entryString(entry, 'stylemap_file')
    if (entry && stylemapFile !== '') {
      declaredStyleKeys.add(stylemapFile.replace(/\.json$/u, ''))
    }
    if (!entry || id === '' || stylemapFile === '') {
      out.issues.push({
        level: 'error',
        rule: 'dir.styleEntry.incomplete',
        path: `manifest.styles[${i}]`,
        message: `manifest.styles 有一条缺 id 或 stylemap_file：${text(
          JSON.stringify(raw)
        )}（程序会跳过该条）`
      })
      continue
    }
    declaredStyleIds.add(id)

    const manifestName = entryString(entry, 'name')
    const manifestStyleFolder = entryString(entry, 'style_folder')
    const issues: ValidationIssue[] = []
    const item: TemplateDirEntry = {
      kind: 'style',
      id,
      name: manifestName || id,
      file: stylemapFile,
      issues
    }
    out.styles.push(item)

    const basePath = join(styleRoot, id)
    if (!existsSync(basePath)) {
      issues.push({
        level: 'error',
        rule: 'style.dir.missing',
        path: label('styles', id),
        message: `styles/${id} 目录不存在（程序找的是 styles/<id>/<stylemap_file>）`
      })
      continue
    }
    const filePath = join(basePath, stylemapFile)
    if (!existsSync(filePath)) {
      issues.push({
        level: 'error',
        rule: 'style.file.missing',
        path: label('styles', id, stylemapFile),
        message: `styles/${id}/${stylemapFile} 不存在（目录名必须等于 manifest 的 id）`
      })
      continue
    }
    const read = readJsonFile(filePath)
    if ('error' in read) {
      issues.push({
        level: 'error',
        rule: 'style.file.parse',
        path: label('styles', id, stylemapFile),
        message: `styles/${id}/${stylemapFile} JSON 解析失败：${read.error}`
      })
      continue
    }
    issues.push(
      ...validateStyleTemplate(read.doc, loadedStructureDocs, {
        id,
        stylemapFile,
        basePath,
        manifestStyleFolder: manifestStyleFolder || undefined
      })
    )
    item.name = nameOfDoc(read.doc, item.name)
    loadedStyles.push({ id, name: item.name })
  }

  // ---------- 目录里有、manifest 没登记 ----------
  for (const name of listSubDirs(structureRoot)) {
    if (!declaredStructureIds.has(name)) {
      out.issues.push({
        level: 'warn',
        rule: 'dir.structure.unregistered',
        path: label('structures', name),
        message: `structures/${name} 目录存在但 manifest 里没有登记，程序不会加载它`
      })
    }
  }
  for (const name of listSubDirs(styleRoot)) {
    if (!declaredStyleIds.has(name)) {
      out.issues.push({
        level: 'warn',
        rule: 'dir.style.unregistered',
        path: label('styles', name),
        message: `styles/${name} 目录存在但 manifest 里没有登记，程序不会加载它`
      })
    }
  }

  // ---------- 同名冲突（程序按先加载优先） ----------
  const structureNameSeen = new Map<string, string>()
  for (const s of loadedStructures) {
    const first = structureNameSeen.get(s.name)
    if (first !== undefined) {
      out.issues.push({
        level: 'error',
        rule: 'dir.structureName.duplicate',
        path: label('structures', s.id),
        message: `结构模板名「${s.name}」重复（${first} 与 ${s.id}），程序只保留先加载的那个`
      })
    } else {
      structureNameSeen.set(s.name, s.id)
    }
  }
  const styleNameSeen = new Map<string, string>()
  for (const s of loadedStyles) {
    const first = styleNameSeen.get(s.name)
    if (first !== undefined) {
      out.issues.push({
        level: 'error',
        rule: 'dir.styleName.duplicate',
        path: label('styles', s.id),
        message: `样式模板名「${s.name}」重复（${first} 与 ${s.id}），程序只保留先加载的那个`
      })
    } else {
      styleNameSeen.set(s.name, s.id)
    }
  }

  // ---------- 结构声明的样式 key 有没有 manifest 条目 ----------
  // 只认"manifest 里声明了 stylemap_file"，与那一份样式本身能否读出来无关（脚本同法）
  for (const s of loadedStructures) {
    for (const key of styleTemplateKeys(s.doc)) {
      if (!declaredStyleKeys.has(key)) {
        out.issues.push({
          level: 'error',
          rule: 'dir.styleTemplate.unregistered',
          path: label('structures', s.id, 'styleTemplate'),
          message: `结构「${s.name}」声明的样式 key「${key}」在 manifest.styles 里没有对应条目`
        })
      }
    }
  }

  return out
}
