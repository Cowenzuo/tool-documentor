/**
 * TemplateManager：模板目录加载、检索、实例化（PLAN-12：清单不再存在，索引按 uuid 建）。
 * - 每个模板目录就是 `structures/<uuid>/<uuid>.json` 与 `styles/<uuid>/<uuid>.json`；
 * - 找与读由 `scanTemplateDir` 负责（目录名不是 uuid 的收进 legacy，交给迁移动作）；
 * - 注册键一律是 uuid：结构模板按 uuid 建索引，样式模板同样，名字只作展示；
 * - 结构模板的默认样式由 `resolveDefaultStyle` 解析，引用只有一个 uuid；
 * - 实例化 = 递归深拷贝模板节点定义 → 文档树，并给每个节点推导 allowedChildLevels。
 * - 加载不说"成功"就算完：每一条没加载、被跳过的块、认不出的取值都进 LoadDirResult，
 *   界面据此说明"为什么少了什么"。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { createBlock, DocumentNode, DocumentTree, parseBlockLock } from '@documentor/core'
import type { BlockLockLevel, ContentBlock } from '@documentor/core'
import { TEMPLATE_SUBDIR, scanTemplateDir } from './discover'
import type { DiscoveredTemplate, TemplateScan } from './discover'
import { displayNameOf, templateIdentityOf } from './identity'
import type { TemplateIdentity } from './identity'
import { resolveDefaultStyle, findStructureByLegacyName } from './resolve'
import type {
  CaptionNumberingMode,
  DefaultStyleRef,
  LoadDirResult,
  StyleTemplateDef,
  StyleValidationReport,
  TemplateContentBlockDef,
  TemplateDef,
  TemplateNodeDef
} from './types'

/**
 * 解析期的两个上报通道（LoadDirResult 结构上就满足）：
 * - skipped：这一条没加载（整份模板被丢弃、块被跳过）；
 * - warnings：加载了但有可疑之处（取值不认识、骨架缺部件），不阻断加载。
 */
interface ReportSink {
  skipped: string[]
  warnings: string[]
}

/** 空扫描：没有任何目录加载过时，解析引用一律按"找不到"处理 */
function emptyScan(): TemplateScan {
  return { structures: [], styles: [], legacy: [], missing: [] }
}

/** 模板在模板目录下的相对位置，只用于报出"是哪一份读不了" */
function whereOf(item: DiscoveredTemplate): string {
  return `${TEMPLATE_SUBDIR[item.kind]}/${item.uuid}`
}

export class TemplateManager {
  /** 结构模板注册表（按 uuid） */
  private structures = new Map<string, TemplateDef>()
  /** 样式模板注册表（按 uuid） */
  private styles = new Map<string, StyleTemplateDef>()
  /**
   * 已加载目录的合并扫描。留着它是因为"这份样式到底在不在"要看目录里实际有什么，
   * 而不是看注册表：注册表里没有有两种可能，读坏了或根本没这份，两种都算悬挂。
   */
  private scanValue: TemplateScan = emptyScan()
  /** 目录加载顺序记录（诊断用） */
  readonly loadedDirs: string[] = []

  // ================= 加载 =================

  /**
   * 加载一个模板目录。目录无效（不存在、两类子目录都缺）返回失败但不抛错。
   * 调用方按 用户目录 → 内置 顺序传入；同一个 uuid 出现在多个目录时保留先加载的那份，
   * 后一份连同来源目录记进 skipped，不再静默覆盖。
   */
  loadTemplateDir(dirPath: string): LoadDirResult {
    const result: LoadDirResult = {
      dirPath,
      structuresLoaded: 0,
      stylesLoaded: 0,
      skipped: [],
      warnings: []
    }
    const scan = scanTemplateDir(dirPath)
    for (const kind of scan.missing) {
      result.skipped.push(`${TEMPLATE_SUBDIR[kind]} 目录不存在`)
    }
    for (const legacy of scan.legacy) {
      result.skipped.push(
        `${TEMPLATE_SUBDIR[legacy.kind]}/${legacy.name} 的目录名不是 uuid，未加载`
      )
    }

    for (const item of scan.structures) {
      if (item.problem !== null || item.doc === null) {
        result.skipped.push(`${whereOf(item)}：${item.problem ?? '模板读不出来'}`)
        continue
      }
      const def = this.parseTemplateDef(item.doc, result)
      if (!def) {
        result.skipped.push(`${whereOf(item)}：缺少 root，整份未加载`)
        continue
      }
      if (this.structures.has(item.uuid)) {
        result.skipped.push(`${whereOf(item)}：这份结构模板已经在别的目录里加载过，忽略本次`)
        continue
      }
      this.structures.set(item.uuid, def)
      result.structuresLoaded += 1
    }

    for (const item of scan.styles) {
      if (item.problem !== null || item.doc === null) {
        result.skipped.push(`${whereOf(item)}：${item.problem ?? '模板读不出来'}`)
        continue
      }
      const styleDef = this.parseStyleTemplateDef(item.doc, item.dir)
      if (!styleDef) {
        result.skipped.push(`${whereOf(item)}：缺少 styleMap，整份未加载`)
        continue
      }
      if (this.styles.has(item.uuid)) {
        result.skipped.push(`${whereOf(item)}：这份样式模板已经在别的目录里加载过，忽略本次`)
        continue
      }
      this.styles.set(item.uuid, styleDef)
      result.stylesLoaded += 1
      // 骨架缺关系表：不拦加载，但要说出来（同一骨架被多份样式共用时只报一条）
      const relsWarning = skeletonRelsWarning(styleDef.skeletonPath)
      if (relsWarning && !result.warnings.includes(relsWarning)) {
        result.warnings.push(relsWarning)
      }
    }

    // 合并扫描：同一个 uuid 只留先加载的那一份，与注册表同一口径
    for (const item of scan.structures) {
      if (!this.scanValue.structures.some((kept) => kept.uuid === item.uuid)) {
        this.scanValue.structures.push(item)
      }
    }
    for (const item of scan.styles) {
      if (!this.scanValue.styles.some((kept) => kept.uuid === item.uuid)) {
        this.scanValue.styles.push(item)
      }
    }
    for (const legacy of scan.legacy) this.scanValue.legacy.push(legacy)
    for (const kind of scan.missing) {
      if (!this.scanValue.missing.includes(kind)) this.scanValue.missing.push(kind)
    }

    if (result.structuresLoaded > 0 || result.stylesLoaded > 0) {
      this.loadedDirs.push(dirPath)
    }
    return result
  }

  // ================= 检索 =================

  listStructures(): TemplateDef[] {
    return [...this.structures.values()]
  }

  listStyles(): StyleTemplateDef[] {
    return [...this.styles.values()]
  }

  /** 按 uuid 查找结构模板 */
  findStructureByUuid(uuid: string): TemplateDef | undefined {
    return this.structures.get(uuid)
  }

  /**
   * 老工程只记了模板名：按名字认回结构模板（PLAN-12 之前建的那批工程）。
   * 只认唯一一份，认不出或撞名字返回 undefined —— 与"模板没了"同样处理。
   */
  findStructureByLegacyName(legacyName: string): TemplateDef | undefined {
    const hit = findStructureByLegacyName(this.scanValue, legacyName)
    return hit ? this.structures.get(hit.uuid) : undefined
  }

  /** 按 uuid 查找样式模板 */
  findStyleByUuid(uuid: string): StyleTemplateDef | undefined {
    return this.styles.get(uuid)
  }

  /**
   * 结构模板的默认样式：解析规则用 `resolve.ts` 那一份，这里只把"目录里有没有"
   * 换成"加载好的那一份"。悬挂与未设分开报，调用方的说法不一样。
   */
  styleForStructure(def: TemplateDef): DefaultStyleRef {
    const resolution = resolveDefaultStyle(this.scanValue, def.defaultStyleUuid)
    const style = this.styles.get(resolution.uuid) ?? null
    return {
      style,
      uuid: resolution.uuid,
      dangling: !resolution.unset && style === null,
      unset: resolution.unset
    }
  }

  // ================= 实例化 =================

  /** 将结构模板实例化为可编辑文档树（深拷贝；节点 id 由 core 计数器分配） */
  instantiate(def: TemplateDef): DocumentTree | null {
    if (!def.rootDef) return null
    const root = this.cloneNodeDef(def.rootDef)
    return new DocumentTree(root)
  }

  private cloneNodeDef(nodeDef: TemplateNodeDef): DocumentNode {
    const node = new DocumentNode(nodeDef.headingLevel)
    node.title = nodeDef.defaultTitle
    node.description = nodeDef.description
    node.copyable = nodeDef.copyable
    node.deletable = nodeDef.deletable
    node.allowContentBlocks = nodeDef.allowContentBlocks
    node.isSubTitle = nodeDef.isSubTitle
    node.subTitleStyle = nodeDef.subTitleStyle
    node.subTitleAutoNumber = nodeDef.subTitleAutoNumber
    node.copyGroupId = nodeDef.copyGroupId

    // allowedChildLevels 由子定义推导（与旧版一致：各子节点 headingLevel 去重）
    const levels: string[] = []
    for (const childDef of nodeDef.defaultChildren) {
      const level = String(childDef.headingLevel)
      if (!levels.includes(level)) levels.push(level)
    }
    node.allowedChildLevels = levels

    for (const blockDef of nodeDef.contentBlocks) {
      const block = templateBlockToContentBlock(blockDef)
      if (block) node.addContentBlock(block)
    }
    for (const childDef of nodeDef.defaultChildren) {
      const child = this.cloneNodeDef(childDef)
      // 校验失败（极端模板数据）时静默丢弃该分支，与旧版 addChild 行为一致
      node.addChild(child)
    }
    return node
  }

  // ================= 解析 =================

  private parseTemplateDef(
    root: Record<string, unknown>,
    sink: ReportSink
  ): TemplateDef | null {
    const identity = templateIdentityOf(root)
    const rootObj = root['root']
    if (!identity || typeof rootObj !== 'object' || rootObj === null) return null
    const rootDef = this.parseNodeDef(rootObj as Record<string, unknown>, identity, sink)
    return {
      ...identity,
      category: String(root['category'] ?? ''),
      description: String(root['description'] ?? ''),
      version: String(root['version'] ?? ''),
      defaultStyleUuid: String(root['defaultStyleUuid'] ?? ''),
      rootDef
    }
  }

  private parseNodeDef(
    obj: Record<string, unknown>,
    identity: TemplateIdentity,
    sink: ReportSink
  ): TemplateNodeDef {
    const nodeType = String(obj['nodeType'] ?? '')
    const nodeTitle = String(obj['title'] ?? '')
    const templateName = displayNameOf(identity)
    const contentBlocks: TemplateContentBlockDef[] = []
    for (const raw of asArray(obj['contentBlocks'])) {
      const b = raw as Record<string, unknown>
      const type = String(b['type'] ?? '')
      // 认不出的块类型会在实例化时被丢掉，这里就报出来，别让模板静默少块
      if (!isKnownTemplateBlockType(type)) {
        sink.skipped.push(
          `结构模板「${templateName}」节点「${nodeTitle}」的内容块类型「${type || '（空）'}」` +
            '不认识，实例化时该块会被跳过'
        )
      }
      contentBlocks.push({
        type,
        caption: b['caption'] == null ? undefined : String(b['caption']),
        content: b['content'] == null ? undefined : String(b['content']),
        language: b['language'] == null ? undefined : String(b['language']),
        rows: b['rows'] == null ? undefined : Number(b['rows']),
        cols: b['cols'] == null ? undefined : Number(b['cols']),
        headers: asArray(b['headers']).map((x) => String(x)),
        data: asArray(b['data']).map((row) => asArray(row).map((x) => String(x))),
        // 表格纵向合并开关只认布尔 true：字符串 'true'、数字 1 这类一律按不设处理
        mergeVertical: b['mergeVertical'] === true ? true : undefined,
        items: asArray(b['items']).map((x) => String(x)),
        lock: parseLockValue(b['lock'], templateName, nodeTitle, (msg) => sink.warnings.push(msg))
      })
    }
    const children: TemplateNodeDef[] = []
    for (const raw of asArray(obj['children'])) {
      children.push(this.parseNodeDef(raw as Record<string, unknown>, identity, sink))
    }
    const isSubTitle = nodeType === 'subTitle' || nodeType === 'subtitle'
    return {
      nodeType,
      defaultTitle: String(obj['title'] ?? ''),
      headingLevel: Number(obj['headingLevel'] ?? 1),
      description: String(obj['description'] ?? ''),
      copyable: Boolean(obj['copyable'] ?? false),
      deletable: Boolean(obj['deletable'] ?? false),
      allowContentBlocks: Boolean(obj['allowContentBlocks'] ?? true),
      isSubTitle,
      subTitleStyle: String(obj['subTitleStyle'] ?? 'numeric'),
      subTitleAutoNumber: Boolean(obj['subTitleAutoNumber'] ?? true),
      copyGroupId: String(obj['copyGroupId'] ?? ''),
      defaultChildren: children,
      contentBlocks
    }
  }

  private parseStyleTemplateDef(
    root: Record<string, unknown>,
    basePath: string
  ): StyleTemplateDef | null {
    const identity = templateIdentityOf(root)
    const mapRaw = root['styleMap']
    if (!identity || typeof mapRaw !== 'object' || mapRaw === null) return null
    const styleMap: Record<string, string> = {}
    for (const [key, value] of Object.entries(mapRaw as Record<string, unknown>)) {
      styleMap[key] = String(value)
    }
    const docxFolder = String(root['docxFolder'] ?? '')
    // 题注编号方式（可选；缺省 auto）
    const cnRaw = root['captionNumbering']
    let captionNumbering: StyleTemplateDef['captionNumbering']
    if (cnRaw && typeof cnRaw === 'object') {
      const r = cnRaw as Record<string, unknown>
      const pick = (v: unknown): CaptionNumberingMode | undefined =>
        v === 'static' ? 'static' : v === 'auto' ? 'auto' : v === 'field' ? 'field' : undefined
      const namesRaw = r['chapterStyleNames']
      let chapterStyleNames: Record<string, string> | undefined
      if (namesRaw && typeof namesRaw === 'object') {
        chapterStyleNames = {}
        for (const [k, v] of Object.entries(namesRaw as Record<string, unknown>)) {
          chapterStyleNames[String(k)] = String(v)
        }
      }
      captionNumbering = {
        table: pick(r['table']),
        figure: pick(r['figure']),
        chapterStyleNames
      }
    }
    const skeletonPath = join(basePath, docxFolder)
    return {
      ...identity,
      version: String(root['version'] ?? ''),
      description: String(root['description'] ?? ''),
      docxFolder,
      basePath,
      styleMap,
      captionNumbering,
      headingStarts: parseHeadingStarts(skeletonPath),
      skeletonPath
    }
  }

  // ================= 校验 =================

  /**
   * 校验样式模板骨架：styles.xml 中存在 styleMap 引用的全部 styleId（与旧版同法：字符串扫描 styleId="..."）。
   * 另外报一条骨架部件关系表的警告（不参与 valid）：缺 word/_rels/document.xml.rels 时
   * styles 与 numbering 从主文档到达不了，Word 可能当它们不存在。
   */
  validateStyleTemplate(styleDef: StyleTemplateDef): StyleValidationReport {
    const stylesPath = join(styleDef.skeletonPath, 'word', 'styles.xml')
    const missing: StyleValidationReport['missing'] = []
    const warnings: string[] = []
    const relsWarning = skeletonRelsWarning(styleDef.skeletonPath)
    if (relsWarning) warnings.push(relsWarning)
    try {
      const xml = readFileSync(stylesPath, 'utf8')
      const validIds = new Set<string>()
      const re = /styleId="([^"]+)"/gu
      let m: RegExpExecArray | null
      while ((m = re.exec(xml)) !== null) {
        validIds.add(m[1]!)
      }
      for (const [logicalName, styleId] of Object.entries(styleDef.styleMap)) {
        if (!validIds.has(styleId)) {
          missing.push({ logicalName, styleId })
        }
      }
    } catch {
      missing.push({ logicalName: '(styles.xml unreadable)', styleId: stylesPath })
    }
    return { valid: missing.length === 0, missing, warnings }
  }
}

/**
 * 从骨架 numbering.xml 的第一个 abstractNum 读取各层级起始编号（ilvl → start）。
 * field 模式算题注章节号缓存值需要它（如报告从第 4 章起编号）。
 */
function parseHeadingStarts(skeletonPath: string): number[] | undefined {
  try {
    const xml = readFileSync(join(skeletonPath, 'word', 'numbering.xml'), 'utf8')
    const abstract = /<w:abstractNum[\s\S]*?<\/w:abstractNum>/.exec(xml)
    if (!abstract) return undefined
    const starts: number[] = []
    for (const m of abstract[0].matchAll(/<w:lvl [^>]*w:ilvl="(\d+)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      const ilvl = Number(m[1])
      const start = /<w:start w:val="(\d+)"/.exec(m[2] ?? '')
      if (start) starts[ilvl] = Number(start[1])
    }
    return starts.length > 0 ? starts : undefined
  } catch {
    return undefined
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 骨架部件关系表检查：缺 `word/_rels/document.xml.rels` 时，styles 与 numbering
 * 无法从主文档到达，Word 可能当它们不存在（真实样式模板都自带该部件，
 * 只有自定义与极简骨架会缺）。导出侧会补出这两条关系，所以只报警告、不判不可用。
 */
function skeletonRelsWarning(skeletonPath: string): string | null {
  if (existsSync(join(skeletonPath, 'word', '_rels', 'document.xml.rels'))) return null
  const parts: string[] = []
  if (existsSync(join(skeletonPath, 'word', 'styles.xml'))) parts.push('styles.xml')
  if (existsSync(join(skeletonPath, 'word', 'numbering.xml'))) parts.push('numbering.xml')
  if (parts.length === 0) return null
  return (
    `样式骨架 ${basename(skeletonPath)} 缺少 word/_rels/document.xml.rels，` +
    `${parts.join(' 与 ')} 可能不被 Word 识别（导出时会补出这两条关系）`
  )
}

/**
 * 解析模板块定义的 lock，只认 type / keep / readonly 三个字符串。
 * 取值不认识时按不锁处理，并把原文交回加载报告（warn 回调），不再只打一行控制台日志；
 * 缺省（没有这个字段）视为不锁，不告警。
 */
function parseLockValue(
  value: unknown,
  templateName: string,
  nodeTitle: string,
  warn: (message: string) => void
): BlockLockLevel | undefined {
  const lock = parseBlockLock(value)
  if (!lock && value != null) {
    warn(
      `结构模板「${templateName}」节点「${nodeTitle}」的内容块 lock 取值` +
        `「${String(value)}」不认识，按不锁处理`
    )
  }
  return lock
}

/**
 * 模板内容块定义 → core 内容块（对齐旧版 instantiate 映射：
 * image.imagePath 取 content；formula.latexCode 取 content；code.code 取 content 等）。
 * 模板锁 lock 一并带到块上，随块进工程数据。
 */
export function templateBlockToContentBlock(
  def: TemplateContentBlockDef
): ContentBlock | null {
  const block = templateBlockOfDef(def)
  if (!block) return null
  // 非法取值在 parseNodeDef 已经滤掉，这里只负责带上
  return def.lock ? ({ ...block, lock: def.lock } as ContentBlock) : block
}

/** 模板内容块类型是否认识；判定口径与 templateBlockOfDef 的 switch 同一个来源 */
export function isKnownTemplateBlockType(type: string): boolean {
  return templateBlockOfDef({ type }) !== null
}

function templateBlockOfDef(def: TemplateContentBlockDef): ContentBlock | null {
  const type = def.type
  switch (type) {
    case 'text': {
      const block = createBlock('text')
      block.content = def.content ?? ''
      return block
    }
    case 'image': {
      const block = createBlock('image')
      block.caption = def.caption ?? ''
      block.imagePath = def.content ?? ''
      return block
    }
    case 'table': {
      const block = createBlock('table')
      block.caption = def.caption ?? ''
      block.rows = def.rows ?? 0
      block.cols = def.cols ?? 0
      block.headers = [...(def.headers ?? [])]
      block.data = (def.data ?? []).map((row) => [...row])
      if (def.mergeVertical === true) block.mergeVertical = true
      return block
    }
    case 'formula': {
      const block = createBlock('formula')
      block.latexCode = def.content ?? ''
      return block
    }
    case 'code': {
      const block = createBlock('code')
      block.language = def.language ?? ''
      block.code = def.content ?? ''
      return block
    }
    case 'mermaid': {
      const block = createBlock('mermaid')
      block.caption = def.caption ?? ''
      block.code = def.content ?? ''
      return block
    }
    case 'orderedList': {
      const block = createBlock('orderedList')
      block.items = [...(def.items ?? [])]
      return block
    }
    case 'unorderedList': {
      const block = createBlock('unorderedList')
      block.items = [...(def.items ?? [])]
      return block
    }
    default:
      return null
  }
}
