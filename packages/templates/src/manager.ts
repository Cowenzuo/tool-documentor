/**
 * TemplateManager：模板目录加载、检索、实例化（对齐旧版 templatemanager 语义）。
 * - 每个模板目录以 manifest.json 驱动：structures/<id>/<file>、styles/<id>/<stylemap>；
 * - 结构模板按 name 注册（先加载者优先，同名跳过并记录）；
 * - 样式模板双 key 注册：name 与 stylemap 文件名（不含 .json）；
 * - 结构模板顶层 styleTemplate 字段（= stylemap 文件名）关联样式；
 * - 实例化 = 递归深拷贝模板节点定义 → 文档树，并给每个节点推导 allowedChildLevels。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createBlock, DocumentNode, DocumentTree } from '@documentor/core'
import type { ContentBlock } from '@documentor/core'
import type {
  LoadDirResult,
  StyleCandidate,
  StyleTemplateDef,
  StyleValidationReport,
  TemplateContentBlockDef,
  TemplateDef,
  TemplateNodeDef
} from './types'

interface ManifestEntry {
  id: string
  name: string
  file?: string
  stylemap_file?: string
  style_folder?: string
  category?: string
  description?: string
}

export class TemplateManager {
  /** 结构模板注册表（按 name） */
  private structures = new Map<string, TemplateDef>()
  /** 结构定义（按 manifest id，供关联检查） */
  private structuresById = new Map<string, TemplateDef>()
  /** 样式模板注册表（name 与 filekey 双 key） */
  private styles = new Map<string, StyleTemplateDef>()
  /** 目录加载顺序记录（诊断用） */
  readonly loadedDirs: string[] = []

  // ================= 加载 =================

  /**
   * 加载一个模板目录（manifest 驱动）。目录无效（不存在/无 manifest/无结构）返回失败但不抛错。
   * 同名注册冲突采用先加载优先（调用方按 用户目录 → 内置 顺序传入，实现用户模板优先）。
   */
  loadTemplateDir(dirPath: string): LoadDirResult {
    const result: LoadDirResult = { dirPath, structuresLoaded: 0, stylesLoaded: 0, skipped: [] }
    const manifestPath = join(dirPath, 'manifest.json')
    if (!existsSync(manifestPath)) {
      result.skipped.push(`manifest.json not found in ${dirPath}`)
      return result
    }
    let manifest: { structures?: ManifestEntry[]; styles?: ManifestEntry[] }
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
    } catch (err) {
      result.skipped.push(`manifest.json parse error: ${String(err)}`)
      return result
    }

    // 结构模板
    for (const entry of manifest.structures ?? []) {
      if (!entry.id || !entry.file) {
        result.skipped.push(`invalid structure entry: ${JSON.stringify(entry)}`)
        continue
      }
      if (this.structures.has(entry.name)) {
        result.skipped.push(`structure already loaded: ${entry.name}`)
        continue
      }
      const filePath = join(dirPath, 'structures', entry.id, entry.file)
      let def: TemplateDef | null = null
      try {
        const doc = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
        def = this.parseTemplateDef(doc)
      } catch (err) {
        result.skipped.push(`cannot load structure ${entry.file}: ${String(err)}`)
      }
      if (def) {
        this.structures.set(def.name, def)
        this.structuresById.set(entry.id, def)
        result.structuresLoaded += 1
      }
    }

    // 样式模板
    for (const entry of manifest.styles ?? []) {
      if (!entry.id || !entry.stylemap_file) {
        result.skipped.push(`invalid style entry: ${JSON.stringify(entry)}`)
        continue
      }
      const basePath = join(dirPath, 'styles', entry.id)
      const stylemapPath = join(basePath, entry.stylemap_file)
      let styleDef: StyleTemplateDef | null = null
      try {
        const doc = JSON.parse(readFileSync(stylemapPath, 'utf8')) as Record<string, unknown>
        styleDef = this.parseStyleTemplateDef(doc, basePath)
      } catch (err) {
        result.skipped.push(`cannot load stylemap ${entry.stylemap_file}: ${String(err)}`)
      }
      if (styleDef) {
        const fileKey = entry.stylemap_file.replace(/\.json$/u, '')
        // 样式同结构一样按先加载优先（name 或 filekey 已注册则跳过）
        if (this.styles.has(styleDef.name) || this.styles.has(fileKey)) {
          result.skipped.push(`style already loaded: ${styleDef.name}`)
          continue
        }
        styleDef.fileKey = fileKey
        this.styles.set(styleDef.name, styleDef)
        this.styles.set(fileKey, styleDef)
        result.stylesLoaded += 1
      }
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
    const seen = new Set<StyleTemplateDef>()
    const out: StyleTemplateDef[] = []
    for (const def of this.styles.values()) {
      if (!seen.has(def)) {
        seen.add(def)
        out.push(def)
      }
    }
    return out
  }

  /** 按结构模板名称查找 */
  findStructureByName(name: string): TemplateDef | undefined {
    return this.structures.get(name)
  }

  /** 按 manifest id 查找结构模板 */
  findStructureById(id: string): TemplateDef | undefined {
    return this.structuresById.get(id)
  }

  /** 按 name 或 stylemap 文件名（不含 .json）查找样式模板 */
  findStyleTemplate(key: string): StyleTemplateDef | undefined {
    return this.styles.get(key)
  }

  /** 结构模板 → 关联样式模板（按 def.styleTemplate 双 key 查找） */
  styleForStructure(def: TemplateDef): StyleTemplateDef | undefined {
    if (!def.styleTemplate) return undefined
    return this.styles.get(def.styleTemplate)
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

  private parseTemplateDef(root: Record<string, unknown>): TemplateDef | null {
    const name = String(root['name'] ?? '')
    const rootObj = root['root']
    if (!name || typeof rootObj !== 'object' || rootObj === null) return null
    const rootDef = this.parseNodeDef(rootObj as Record<string, unknown>)
    const styleTemplate = String(root['styleTemplate'] ?? '')
    const rawList = asArray(root['styleTemplates']).map((x) => String(x)).filter(Boolean)
    // 兼容：缺 styleTemplates 时回退单元素集合
    const styleTemplates = rawList.length > 0 ? rawList : styleTemplate ? [styleTemplate] : []
    if (!styleTemplates.includes(styleTemplate) && styleTemplate) {
      styleTemplates.unshift(styleTemplate)
    }
    return {
      name,
      category: String(root['category'] ?? ''),
      description: String(root['description'] ?? ''),
      version: String(root['version'] ?? ''),
      styleTemplate,
      styleTemplates,
      rootDef
    }
  }

  private parseNodeDef(obj: Record<string, unknown>): TemplateNodeDef {
    const nodeType = String(obj['nodeType'] ?? '')
    const contentBlocks: TemplateContentBlockDef[] = []
    for (const raw of asArray(obj['contentBlocks'])) {
      const b = raw as Record<string, unknown>
      contentBlocks.push({
        type: String(b['type'] ?? ''),
        caption: b['caption'] == null ? undefined : String(b['caption']),
        content: b['content'] == null ? undefined : String(b['content']),
        language: b['language'] == null ? undefined : String(b['language']),
        rows: b['rows'] == null ? undefined : Number(b['rows']),
        cols: b['cols'] == null ? undefined : Number(b['cols']),
        headers: asArray(b['headers']).map((x) => String(x)),
        data: asArray(b['data']).map((row) => asArray(row).map((x) => String(x))),
        items: asArray(b['items']).map((x) => String(x))
      })
    }
    const children: TemplateNodeDef[] = []
    for (const raw of asArray(obj['children'])) {
      children.push(this.parseNodeDef(raw as Record<string, unknown>))
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
    const name = String(root['name'] ?? '')
    const mapRaw = root['styleMap']
    if (!name || typeof mapRaw !== 'object' || mapRaw === null) return null
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
      const pick = (v: unknown): 'auto' | 'static' | undefined =>
        v === 'static' ? 'static' : v === 'auto' ? 'auto' : undefined
      captionNumbering = { table: pick(r['table']), figure: pick(r['figure']) }
    }
    return {
      name,
      version: String(root['version'] ?? ''),
      description: String(root['description'] ?? ''),
      fileKey: '',
      docxFolder,
      basePath,
      styleMap,
      captionNumbering,
      skeletonPath: join(basePath, docxFolder)
    }
  }

  // ================= 校验 =================

  /** 校验样式模板骨架：styles.xml 中存在 styleMap 引用的全部 styleId（C++ 同法：字符串扫描 styleId="..."） */
  validateStyleTemplate(styleDef: StyleTemplateDef): StyleValidationReport {
    const stylesPath = join(styleDef.skeletonPath, 'word', 'styles.xml')
    const missing: StyleValidationReport['missing'] = []
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
    return { valid: missing.length === 0, missing }
  }

  // ================= 结构 × 样式配对（软校验候选） =================

  /**
   * 结构模板的可用样式候选（1:N，含默认标记与不可用原因）。
   * 软校验：不可用的候选不影响结构模板加载/编辑，仅导出入口据此收敛。
   */
  styleCandidatesForStructure(def: TemplateDef): StyleCandidate[] {
    const required = requiredStyleKeys(def)
    const candidates: StyleCandidate[] = []
    for (const fileKey of def.styleTemplates) {
      const style = this.styles.get(fileKey)
      if (!style) {
        candidates.push({
          fileKey,
          name: fileKey,
          version: '',
          description: '',
          available: false,
          missingKeys: ['（样式未注册）'],
          isDefault: fileKey === def.styleTemplate
        })
        continue
      }
      const missing = required.filter((key) => !(key in style.styleMap))
      const report = this.validateStyleTemplate(style)
      for (const miss of report.missing) {
        if (!missing.includes(miss.logicalName)) {
          missing.push(`${miss.logicalName}(styleId ${miss.styleId})`)
        }
      }
      candidates.push({
        fileKey,
        name: style.name,
        version: style.version,
        description: style.description,
        available: missing.length === 0,
        missingKeys: [...missing],
        isDefault: fileKey === def.styleTemplate
      })
    }
    return candidates
  }

  /** 结构模板的默认样式候选（不可用时仍返回，由调用方按 available 处理） */
  defaultStyleCandidate(def: TemplateDef): StyleCandidate | null {
    return this.styleCandidatesForStructure(def).find((c) => c.isDefault) ?? null
  }
}

/**
 * 静态推导结构模板所需的逻辑样式键集合（用于样式配对校验）。
 * 规则见 PLAN-03 §2.2：heading.L / subtitle.1..D / body / table.* / figure.caption / list.*
 * 说明：图片/图形的段落样式键 `figure` 为**可选**键——样式表未提供时按 body 输出（向后兼容），
 * 因此不列入必需键，避免老样式表被判为不可用。
 */
export function requiredStyleKeys(def: TemplateDef): string[] {
  const keys = new Set<string>()
  const walk = (node: TemplateNodeDef, subDepth: number): void => {
    if (node.isSubTitle) {
      const depth = subDepth + 1
      for (let d = 1; d <= depth; d++) keys.add(`subtitle.${d}`)
    } else if (node.headingLevel > 0) {
      keys.add(`heading.${node.headingLevel}`)
    }
    for (const block of node.contentBlocks) {
      switch (block.type) {
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
      }
    }
    for (const child of node.defaultChildren) {
      walk(child, node.isSubTitle ? subDepth + 1 : 0)
    }
  }
  walk(def.rootDef, 0)
  return [...keys].sort()
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 模板内容块定义 → core 内容块（对齐旧版 instantiate 映射：
 * image.imagePath 取 content；formula.latexCode 取 content；code.code 取 content 等）。
 */
export function templateBlockToContentBlock(
  def: TemplateContentBlockDef
): ContentBlock | null {
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
