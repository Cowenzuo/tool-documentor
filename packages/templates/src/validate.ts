/**
 * validate.ts — 单份模板的静态校验（结构模板 + 样式模板）：规则的唯一实现。
 *
 * 口径（PLAN-12）：模板的引用只认 uuid，目录与文件名都用 uuid，清单不再存在。
 * 所以这里只做**单份模板自己**能判的事，不查目录、不查清单、不比名字：
 *   1. `parseSkeletonIndex(skeletonPath)`：读骨架 styles.xml / numbering.xml，给出可读样式表
 *      （styleId、样式名、段落或字符、字号）与各级标题起始号；
 *   2. `validateStructureTemplate`：身份（uuid / 中文名）、root、整棵节点树的节点开关与内容块字段；
 *   3. `validateStyleTemplate`：身份、styleMap、docxFolder、骨架部件与 styleId，
 *      以及"软件支持的全部样式键有没有配齐"；样式完整性按固定全集查，与任何结构模板无关。
 *
 * 输入一律是**模板 JSON 原文**（`JSON.parse` 的结果），不是加载器解析后的
 * `TemplateDef`：判的是原文（节点上有没有写 lock、headingLevel 是不是整数、
 * 块上有没有多写节点级字段），这些信息在解析成 TemplateDef 时就丢了。
 *
 * 规则本身与文案不碰目录：`validateStyleMap`（`./style-rules`）不读文件系统，
 * 渲染层实时跑的是同一份；这一层只负责把骨架读成事实再交给它。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BlockLockLevel } from '@documentor/core'
import { isTemplateUuid } from './identity'
import { validateStyleMap } from './style-rules'
import type { SkeletonFacts } from './style-rules'

// ================= 常量 =================

/**
 * 认识的内容块类型。与 `@documentor/core` 的 `BLOCK_TYPE_NAMES` 同值同序。
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
 * 块锁三档（PLAN-09 内容块锁定方案）。**顺序参与文案**：
 * 非法取值时按 `"type" / "keep" / "readonly"` 列出，不要调整。
 * 与 `@documentor/core` 的 `BLOCK_LOCK_LEVELS` 同值同序。
 */
export const LOCK_TIERS: readonly BlockLockLevel[] = ['type', 'keep', 'readonly']

/** 骨架必需部件，顺序参与文案 */
export const SKELETON_REQUIRED_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'word/document.xml',
  'word/styles.xml',
  'word/numbering.xml'
] as const

// ================= 对外类型 =================

export type ValidationLevel = 'error' | 'warn'

/**
 * 一条校验结论。
 * - `path`：出问题的位置，JSON 路径（`root.children[2].contentBlocks[0].lock`）或字段/部件名
 *   （`styleMap['body']`、`skeleton/word/styles.xml`）；
 * - `message`：给人看的说明文案，可直接展示给模板作者；
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
   * 这是**校验用的口径**（与 manager.ts 的 validateStyleTemplate 同法），
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

/**
 * `validateStyleTemplate` 的选项。
 * 只给 `basePath` 时才知道骨架在哪；不给就跳过所有需要读骨架的检查
 * （骨架部件、styleId 是否在骨架里、起始编号），身份与 styleMap 那几条照常判。
 */
export interface StyleValidateOptions {
  /** 模板目录 `styles/<uuid>` 的绝对路径 */
  basePath?: string
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
 * 取数组字段：字段不是数组时按空处理（加载器 manager.ts 的 asArray 也是这个口径），
 * 唯一的效果是坏模板不把校验器打崩。
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

/** 与旧版同法：trail 为空串时显示 (root) */
function whereOf(trail: string): string {
  return trail || '(root)'
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
 * **与 manager.ts 的 validateStyleTemplate 同法**：按字面匹配 `styleId="..."`，不做 XML 解析
 * （解析器对 <w:style> 之外的 styleId 引用行为不一致，两处必须同法）。
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
 * 只认第一个 `abstractNum`、`<w:lvl ...>` 必须成对闭合、只认 `<w:start w:val="..."/>`；
 * 读不到返回 `undefined`。程序算题注章节号读的就是这个（manager.ts 的 parseHeadingStarts 同法）。
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
 * 由 `validateStyleMap` 负责报「缺部件」。
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

// ================= 结构模板校验 =================

/**
 * 校验结构模板：身份（uuid / 中文名）、root、整棵节点树的节点开关、内容块字段、
 * 表格形状、锁取值与复制组开关。
 *
 * 引用指向的样式在不在不在这里判：那是加载与解析的事（找不到就是悬挂，由用户重选）。
 */
export function validateStructureTemplate(def: unknown): ValidationIssue[] {
  const out: ValidationIssue[] = []
  const doc = asObject(def) ?? {}

  if (!isTemplateUuid(doc['uuid'])) {
    out.push({
      level: 'error',
      rule: 'structure.uuid.invalid',
      path: 'uuid',
      message: `顶层uuid缺失或非法`
    })
  }
  const cn = doc['cn']
  if (typeof cn !== 'string' || cn.trim() === '') {
    out.push({
      level: 'error',
      rule: 'structure.cn.missing',
      path: 'cn',
      message: `顶层cn缺失`
    })
  }
  const root = asObject(doc['root'])
  if (!root) {
    out.push({
      level: 'error',
      rule: 'structure.root.missing',
      path: 'root',
      message: `顶层root缺失`
    })
    return out
  }

  checkStructureNode(root, '', 'root', out)
  checkCopyGroups(root, 'root', out)
  return out
}

/**
 * 递归检查节点与其内容块。
 * `trail` 是给作者看的位置串（节点标题拼出来的），`path` 是 JSON 路径。
 */
function checkStructureNode(
  node: Record<string, unknown>,
  trail: string,
  path: string,
  out: ValidationIssue[]
): void {
  const where = whereOf(trail)
  const level = node['headingLevel']

  if (node['title'] === undefined) {
    out.push({
      level: 'warn',
      rule: 'node.title.missing',
      path: `${path}.title`,
      message: `title缺失`
    })
  }
  // lock 是块级字段：写在节点上不生效，节点级仍用 copyable / deletable / allowContentBlocks
  if ('lock' in node) {
    out.push({
      level: 'error',
      rule: 'node.lock.misplaced',
      path: `${path}.lock`,
      message: `lock位置错误`
    })
  }
  if (level !== undefined && (!Number.isInteger(level as number) || (level as number) < 0)) {
    out.push({
      level: 'error',
      rule: 'node.headingLevel.invalid',
      path: `${path}.headingLevel`,
      message: `headingLevel非法`
    })
  }
  if ((level as number) > 9) {
    out.push({
      level: 'warn',
      rule: 'node.headingLevel.deep',
      path: `${path}.headingLevel`,
      message: `headingLevel超深`
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
      message: `copyable / deletable未写`
    })
  }

  // 内容块
  const blocks = asArray(node['contentBlocks'])
  for (let i = 0; i < blocks.length; i++) {
    const b = asObject(blocks[i])
    const bw = `${where} › 第 ${i + 1} 块`
    const bp = `${path}.contentBlocks[${i}]`
    if (!b) {
      // 坏模板按"未知类型"报一条，不再往下判
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
        message: `${bw} · content缺失`
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
        message: `${bw} · items缺失`
      })
    }
    if (b['type'] === 'image') {
      if (typeof b['content'] !== 'string') {
        out.push({
          level: 'error',
          rule: 'block.image.content',
          path: `${bp}.content`,
          message: `${bw} · content缺失`
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
          message: `${bw} · content缺失`
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
    checkStructureNode(child, childTrail, `${path}.children[${i}]`, out)
  }
}

/** 表格块的形状检查 */
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
    // 只判"开了开关但 data 全是空串"——程序按内容判定，空串不上合并
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
 * 复制组检查：只判"有 copyGroupId 但 copyable 不是 true"。
 * 复制组的份数统计是事实陈述，不是问题，故不产出结论。
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
 * 校验样式模板：**读盘这一层**。
 *
 * 规则本身在 `./style-rules` 的 `validateStyleMap`（不碰 fs，编辑模式在渲染层实时跑同一份）。
 * 这里负责把骨架读成"事实"——目录在不在、缺哪些部件、styleId 有哪些、起始编号是多少——
 * 然后交给那份实现去判。样式完整性按软件支持的全集查缺键，与结构模板无关。
 *
 * @param styleDef stylemap JSON 原文（`{ uuid, cn, en, styleMap, docxFolder, captionNumbering }`）
 * @param opts `basePath`（`styles/<uuid>` 目录；不给就跳过需要骨架的检查）
 */
export function validateStyleTemplate(
  styleDef: unknown,
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
  return validateStyleMap(styleDef, skeleton === undefined ? {} : { skeleton })
}
