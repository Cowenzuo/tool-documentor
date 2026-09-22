/**
 * template-editor-service.ts — 模板编辑模式（PLAN-12：身份是 uuid）的主进程服务：只动模板目录里的 JSON。
 *
 * 边界：
 *   - 不依赖工程库/数据库，不进撤销栈（编辑模式与文档会话是两套东西）；
 *   - 结构模板可读可写、可改名与删除；样式模板可读，对照表可写、可导入、可改名与删除，
 *     也能改名与删除——都只动**模板自己**那一个 JSON 或整份目录（骨架里的字节一个不改）；
 *   - 模板目录里没有清单：uuid 在每份模板自己的 JSON 里，目录名就是 uuid，
 *     要索引就扫目录（`scanTemplateDir`），本文件不维护第二份登记；
 *   - 改名只写 JSON：不碰目录名、不碰文件名、不碰任何引用；
 *   - 可恢复性归版本控制：不写 `.bak`、不留备份目录、不回滚（模板目录通常就在 git 里）；
 *   - 校验口径全部来自 `@documentor/templates` 的 validate，本文件不重写任何规则；
 *   - 写盘一律"写临时文件 → 改名覆盖"：任何一步失败都不留半截文件；
 *   - 序列化沿用现行模板的 2 空格缩进，字段顺序按解析后的插入顺序自然保留；
 *     若原文件是 CRLF，写回时保持 CRLF，免得整份文件行尾翻转。
 *
 * 依赖注入：模板目录列表与应用数据目录由调用方（ipc.ts）从应用设置与 Electron 取，
 * 于是本文件不 import electron，本机单测可以直接跑它。
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import JSZip from 'jszip'
import { exportTreeToDocx } from '@documentor/docx'
import { localIsoNow } from '@documentor/core/time'
import {
  SKELETON_REQUIRED_PARTS,
  TEMPLATE_SUBDIR,
  TemplateManager,
  buildStyleMapRows,
  draftStyleMap,
  identityFields,
  isTemplateUuid,
  newTemplateUuid,
  parseSkeletonIndex,
  scanTemplateDir,
  templateFileName,
  unusedSkeletonStyleIds,
  validateStructureTemplate,
  validateStyleTemplate
} from '@documentor/templates'
import type {
  DiscoveredTemplate,
  SkeletonStyleInfo,
  StyleMapDraft,
  TemplateKind,
  TemplateScan,
  ValidationIssue
} from '@documentor/templates'
import type {
  SkeletonStyleDto,
  StyleMapRowDto,
  TemplateCreateInput,
  TemplateDeleteInput,
  TemplateDirSnapshotDto,
  TemplateEditorSnapshotDto,
  TemplateEntryDto,
  TemplateIssueDto,
  TemplateMigrateInput,
  TemplateMigrateResult,
  TemplateReadInput,
  TemplateReadResult,
  TemplateRenameInput,
  TemplateSaveInput,
  TemplateSaveResult,
  TemplateStyleImportInput,
  TemplateStyleImportResult,
  TemplateStyleReadInput,
  TemplateStyleReadResult,
  TemplateStyleRenameInput,
  TemplateStyleRenameResult,
  TemplateStyleSaveInput,
  TemplateStyleSaveResult,
  TemplateStyleSkeletonDto,
  TemplateStyleUserDto,
  TemplateTrialInput,
  TemplateTrialResult
} from '../../shared/project'

/** 服务层错误：ipc 的 handle() 会把 message 原样交给渲染层 */
export class TemplateEditorError extends Error {}

export interface TemplateEditorServiceDeps {
  /** 应用设置里的模板目录（settings.template_dirs），顺序即界面顺序 */
  templateDirs: () => string[]
  /** 应用数据目录（Electron userData）；试跑产物落 `<它>/template-trials` */
  appDataDir: () => string
}

// ================= 常量 =================

/** 试跑产物目录（应用数据目录下） */
const TRIAL_DIR = 'template-trials'
/** 模板 JSON 的缩进：现行模板全是 2 空格 */
const TEMPLATE_INDENT = 2
/** 导入样式时骨架文件夹的缺省名 */
const DEFAULT_SKELETON_FOLDER = 'skeleton'
/** 旧格式的清单文件名：迁移时删掉它 */
const MANIFEST_FILE = 'manifest.json'

// ================= 工具 =================

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** uuid 定位：目录名与文件名都是它，写歪了就拼不出路径，所以先判合法 */
function assertTemplateUuid(uuid: unknown, what: string): asserts uuid is string {
  if (
    typeof uuid !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(uuid)
  ) {
    throw new TemplateEditorError(`${what}「${String(uuid)}」不是合法的 uuid`)
  }
}

/** 骨架文件夹名：用户可能手填，不许带路径分隔符跑出模板目录 */
const INVALID_DIR_NAME = /[\\/:*?"<>|\u0000-\u001f]/u
function assertSafeFolderName(folder: unknown, what: string): asserts folder is string {
  if (
    typeof folder !== 'string' ||
    folder === '' ||
    folder === '.' ||
    folder === '..' ||
    INVALID_DIR_NAME.test(folder) ||
    folder.endsWith('.') ||
    folder.endsWith(' ')
  ) {
    throw new TemplateEditorError(`${what}「${String(folder)}」不是合法的目录名`)
  }
}

/** 写完的临时文件改名覆盖；失败时清掉临时文件，不留半截 */
function writeFileAtomic(filePath: string, content: string): void {
  const tmp = join(
    dirname(filePath),
    `.${basename(filePath)}.tmp-${process.pid}-${Date.now().toString(36)}`
  )
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, filePath)
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      // 清理失败不能盖掉真正的错误
    }
    throw new TemplateEditorError(`写入失败：${filePath}：${messageOf(err)}`)
  }
}

/** 序列化 JSON：默认 LF 加末尾换行；原文件是 CRLF 时写回 CRLF */
function serializeJson(
  doc: unknown,
  indent: number | string,
  eol: string,
  trailingNewline: boolean
): string {
  const body = JSON.stringify(doc, null, indent) + (trailingNewline ? '\n' : '')
  return eol === '\n' ? body : body.split('\n').join(eol)
}

/** 原文件的换行风格（读不到就按 LF） */
function eolOf(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8').includes('\r\n') ? '\r\n' : '\n'
  } catch {
    return '\n'
  }
}

/** 本地时间戳 `yyyyMMdd-HHmmss`（试跑产物名用，本地时区，便于和用户的钟对上） */
function stampOf(date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/** 文档树的节点数（含根），试跑结果里报一句"这份模板实例化出多少节点" */
function countTreeNodes(tree: { root?: unknown }): number {
  const walk = (node: unknown): number => {
    if (typeof node !== 'object' || node === null) return 0
    const children = (node as { children?: unknown }).children
    const list = Array.isArray(children) ? children : []
    return 1 + list.reduce((sum: number, child) => sum + walk(child), 0)
  }
  return walk(tree.root)
}

/** 校验结论原样就是 IPC 的 DTO（同形状），这里只做一次显式转换，防止两边字段名漂移 */
function toIssueDto(issue: ValidationIssue): TemplateIssueDto {
  return { level: issue.level, rule: issue.rule, path: issue.path, message: issue.message }
}

/** 骨架样式 → DTO：界面上的下拉要的是"名字 + 能在 styles.xml 里认出它"，其余是顺带的线索 */
function toSkeletonStyleDto(style: SkeletonStyleInfo): SkeletonStyleDto {
  return {
    styleId: style.styleId,
    name: style.name,
    type: style.type,
    isDefault: style.isDefault,
    ...(style.basedOn === undefined ? {} : { basedOn: style.basedOn }),
    ...(style.fontSizePt === undefined ? {} : { fontSizePt: style.fontSizePt }),
    ...(style.numbered === undefined ? {} : { numbered: style.numbered })
  }
}

/** 读一份 JSON 对象文件：不存在 / 读失败 / 解析失败 / 顶层不是对象都抛，消息里带上按哪个名字找的 */
function readJsonObjectFile(
  what: string,
  label: string,
  filePath: string,
  hint = ''
): Record<string, unknown> {
  if (!existsSync(filePath)) {
    throw new TemplateEditorError(`${what}文件不存在：${label}${hint}`)
  }
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new TemplateEditorError(`${what}读取失败：${label}：${messageOf(err)}`)
  }
  let doc: unknown
  try {
    doc = JSON.parse(raw) as unknown
  } catch (err) {
    throw new TemplateEditorError(`${what} JSON 解析失败：${label}：${messageOf(err)}`)
  }
  if (!isPlainObject(doc)) {
    throw new TemplateEditorError(`${what}顶层必须是 JSON 对象：${label}`)
  }
  return doc
}

/** 与 `@documentor/templates` 同法：任意 JSON 值按 JS 插值语义转成文案 */
function text(value: unknown): string {
  return String(value)
}

/** 从原文里认缩进宽度（看第一个缩进行）；认不出按 2 空格 */
function detectIndent(raw: string): number | string {
  const m = /^[^\n]*\n([ \t]+)"/u.exec(raw)
  const pad = m?.[1]
  if (pad === undefined) return TEMPLATE_INDENT
  return pad.includes('\t') ? '\t' : pad.length
}

// ================= 定位 =================

/**
 * 一份模板的最小定位信息（结构与样式共用）：目录名与文件名都是 uuid，
 * 所以只靠 dir + kind + uuid 就能拼出全部路径，不需要任何登记。
 */
interface LocatedTemplate {
  kind: TemplateKind
  /** 模板目录（绝对路径） */
  dir: string
  uuid: string
  /** `<模板目录>/<structures|styles>/<uuid>` 绝对路径 */
  dirPath: string
  /** `<dirPath>/<uuid>.json` 绝对路径 */
  filePath: string
}

function emptyScan(): TemplateScan {
  return { structures: [], styles: [], legacy: [], missing: [] }
}

/**
 * 列表按主名排。目录名是 uuid，扫出来的顺序对人不构成任何意义，
 * 界面上该按名字念得出来的次序排（中文按拼音，英文按字母）。
 */
function byName(entries: TemplateEntryDto[]): TemplateEntryDto[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name, 'zh'))
}

/** 旧格式的那些子目录：目录名不是 uuid 的都算 */
function legacyDirsIn(base: string): string[] {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !isTemplateUuid(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * 旧格式的模板 JSON：老约定是 `<老 id>-stylemap.json` 与 `<老 id>-structure.json`，
 * 认不出就取目录里唯一那份 `.json`，取不到返回 null。
 */
function legacyJsonFile(dirPath: string, oldId: string, kind: 'stylemap' | 'structure'): string | null {
  const expected = join(dirPath, `${oldId}-${kind}.json`)
  if (existsSync(expected)) return expected
  let names: string[] = []
  try {
    names = readdirSync(dirPath).filter((name) => name.toLowerCase().endsWith('.json'))
  } catch {
    return null
  }
  return names.length === 1 ? join(dirPath, names[0]!) : null
}

/**
 * 老模板只有一个 name，常把英文名括在末尾（`438C-软件设计说明(SDD)`）。
 * 拆成主名与副名：括着的英文名当副名，没有就把老的目录 id 当副名，留个可追溯的英文键。
 */
function legacyIdentityOf(doc: Record<string, unknown>, oldId: string): { cn: string; en: string } {
  const name = typeof doc['name'] === 'string' ? doc['name'].trim() : ''
  const matched = /^(.*?)[（(]([^（()）]*[A-Za-z][^（()）]*)[)）]$/u.exec(name)
  if (matched) return { cn: (matched[1] ?? '').trim(), en: (matched[2] ?? '').trim() }
  return { cn: name === '' ? oldId : name, en: oldId }
}

/** 从旧文件里原样搬过来的字段（没写的就不写） */
function pickFields(doc: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) if (doc[key] !== undefined) out[key] = doc[key]
  return out
}

// ================= 服务 =================

export class TemplateEditorService {
  constructor(private readonly deps: TemplateEditorServiceDeps) {}

  /**
   * 打开编辑模式时的全貌：设置里在用的模板目录逐个扫描，给出目录级问题与模板列表。
   * `defaultDir` 取第一个存在的目录，没有就是 null。
   */
  snapshot(): TemplateEditorSnapshotDto {
    const dirs: TemplateDirSnapshotDto[] = []
    let defaultDir: string | null = null
    for (const dir of this.templateDirList()) {
      const exists = existsSync(dir)
      const scan = exists ? scanTemplateDir(dir) : emptyScan()
      const issues: ValidationIssue[] = []
      if (!exists) {
        issues.push({
          level: 'error',
          rule: 'dir.missing',
          path: dir,
          message: `模板目录不存在`
        })
      }
      for (const kind of scan.missing) {
        issues.push({
          level: 'error',
          rule: 'dir.subdir.missing',
          path: TEMPLATE_SUBDIR[kind],
          message: `${TEMPLATE_SUBDIR[kind]} 目录不存在`
        })
      }
      for (const legacy of scan.legacy) {
        issues.push({
          level: 'error',
          rule: 'dir.legacy',
          path: `${TEMPLATE_SUBDIR[legacy.kind]}/${legacy.name}`,
          message: `目录名不是 uuid，需要迁移`
        })
      }

      const structureNames = scan.structures.map((item) => ({
        name: item.name,
        defaultStyleUuid: text(item.doc?.['defaultStyleUuid'] ?? '')
      }))
      dirs.push({
        dir,
        exists,
        issues: issues.map(toIssueDto),
        structures: byName(scan.structures.map((item) => this.entryOf(item))),
        styles: byName(
          scan.styles.map((item) => ({
            ...this.entryOf(item),
            usedBy: structureNames
              .filter((s) => s.defaultStyleUuid === item.uuid)
              .map((s) => s.name)
          }))
        )
      })
      if (defaultDir === null && exists) defaultDir = dir
    }
    return { defaultDir, dirs }
  }

  /** 扫描到的一份模板 → 列表条目（读不了的按一条 error 报，不往下判） */
  private entryOf(item: DiscoveredTemplate): TemplateEntryDto {
    const path = `${TEMPLATE_SUBDIR[item.kind]}/${item.uuid}`
    let issues: ValidationIssue[]
    if (item.problem !== null || item.doc === null) {
      issues = [
        {
          level: 'error',
          rule: 'template.unreadable',
          path,
          message: item.problem ?? '模板读不出来'
        }
      ]
    } else {
      issues =
        item.kind === 'structure'
          ? validateStructureTemplate(item.doc)
          : validateStyleTemplate(item.doc, { basePath: item.dir })
    }
    const errors = issues.filter((i) => i.level === 'error').length
    return {
      kind: item.kind,
      uuid: item.uuid,
      name: item.name,
      en: item.identity?.en ?? '',
      errors,
      warnings: issues.length - errors,
      issues: issues.map(toIssueDto)
    }
  }

  /** 读一份结构模板原文：按 uuid 定位 `structures/<uuid>/<uuid>.json` */
  read(input: TemplateReadInput): TemplateReadResult {
    const located = this.locate(input.dir, input.uuid, 'structure')
    const doc = this.readDocOf(located)
    return {
      dir: located.dir,
      uuid: located.uuid,
      doc,
      issues: validateStructureTemplate(doc).map(toIssueDto)
    }
  }

  /**
   * 读一份样式模板（PLAN-11 批次 3）：stylemap 原文 + 骨架样式表 + 对照表。
   *
   * 对照表里的"缺"按**软件支持的全集**算（`SUPPORTED_STYLE_KEYS`），与任何结构模板无关；
   * `usedBy` 只是事实陈述——哪些结构把这份样式写成了默认样式。
   * `issues` 是 `validateStyleTemplate` 的原话，与模板列表里的徽标、保存前的闸门同一份；
   * `rows` 只是它的逐行视图，两者看的是同一份 styleMap 与同一个骨架索引。
   */
  readStyle(input: TemplateStyleReadInput): TemplateStyleReadResult {
    const located = this.locate(input.dir, input.uuid, 'style')
    const doc = this.readDocOf(located)
    const docxFolder = typeof doc['docxFolder'] === 'string' ? doc['docxFolder'] : ''
    const skeletonPath = docxFolder === '' ? located.dirPath : join(located.dirPath, docxFolder)
    const skeleton = this.skeletonFacts(located, docxFolder)
    const styleMap = isPlainObject(doc['styleMap']) ? doc['styleMap'] : {}

    const rows: StyleMapRowDto[] = buildStyleMapRows({
      styleMap,
      skeletonStyleIds: skeleton.dto.styleIds.length > 0 ? skeleton.dto.styleIds : null,
      skeletonStyles: skeleton.styles
    })

    return {
      dir: located.dir,
      uuid: located.uuid,
      doc,
      skeletonPath,
      skeletonExists: skeleton.dto.exists,
      skeleton: skeleton.dto,
      skeletonStyles: skeleton.styles.map(toSkeletonStyleDto),
      unusedStyleIds: unusedSkeletonStyleIds(styleMap, skeleton.styles),
      rows,
      usedBy: this.structuresUsing(located.dir, located.uuid),
      issues: validateStyleTemplate(doc, { basePath: located.dirPath }).map(toIssueDto)
    }
  }

  /**
   * 试跑（PLAN-11 批次 4）：拿这份结构模板 + 它默认的样式模板，**真的导出一份 .docx**。
   *
   * 判据是导出链路的告警：结构里用到的每个样式键都得在骨架里找到对应样式，
   * 否则那一段会按默认样式输出（`…的样式未生效`）——这类告警必须为零。
   * 走的是与正式导出同一条链路（`TemplateManager` 实例化 + `exportTreeToDocx`），
   * 产物落在应用数据目录的 `template-trials/`，可以直接用 Word 打开回读。
   */
  async trialRun(input: TemplateTrialInput): Promise<TemplateTrialResult> {
    const located = this.locate(input.dir, input.uuid, 'structure')
    const doc = this.readDocOf(located)
    const issues = validateStructureTemplate(doc)
    const firstError = issues.find((i) => i.level === 'error')
    if (firstError) {
      // 有 error 的模板实例化出来也是坏的：先让作者改好，别拿一份坏模板去试
      throw new TemplateEditorError(
        `这份模板校验没过，先改好再试跑（${firstError.path}）：${firstError.message}`
      )
    }

    const manager = new TemplateManager()
    manager.loadTemplateDir(located.dir)
    const def = manager.findStructureByUuid(located.uuid)
    if (!def) {
      throw new TemplateEditorError('加载器没认出这份模板，试跑不了')
    }
    const ref = manager.styleForStructure(def)
    if (!ref.style) {
      throw new TemplateEditorError(
        ref.unset
          ? '这份结构没配默认样式，试跑不知道用哪份'
          : '这份结构的默认样式找不到，可能已被删除，先重选一份'
      )
    }
    const tree = manager.instantiate(def)
    if (!tree) throw new TemplateEditorError('实例化失败：这份结构模板没生成出文档树')

    const outputDir = join(this.trialRoot(), located.uuid)
    mkdirSync(outputDir, { recursive: true })
    const outputPath = join(outputDir, `${located.uuid}-${stampOf()}.docx`)
    const exported = await exportTreeToDocx(tree, ref.style, outputPath)
    const styleWarnings = exported.warnings.filter((w) => w.includes('样式未生效'))
    return {
      outputPath: exported.outputPath,
      nodes: countTreeNodes(tree),
      styleUuid: ref.uuid,
      warnings: exported.warnings,
      styleWarnings
    }
  }

  /** 试跑产物目录：应用数据目录下的 `template-trials` */
  private trialRoot(): string {
    const base = this.deps.appDataDir()
    if (typeof base !== 'string' || base.trim() === '') {
      throw new TemplateEditorError('取不到应用数据目录，试跑产物没地方放')
    }
    return join(resolve(base), TRIAL_DIR)
  }

  /**
   * 导入一份自备样式（PLAN-11 批次 3 步骤 4）：源可以是 `.docx` 文件，也可以是**已经解包**的
   * 骨架目录；两条路走同一套检查——必需部件齐不齐（缺一个就报错并把这半份目录清掉）。
   *
   * 落点：`styles/<新 uuid>/<骨架目录>/` 与 `styles/<新 uuid>/<新 uuid>.json`（对照表草稿）。
   * 草稿是**按样式名模糊匹配**出来的：认出来的先填上，认不出的留空待作者填（绝不编 styleId）。
   */
  async importStyle(input: TemplateStyleImportInput): Promise<TemplateStyleImportResult> {
    const dir = this.requireTemplateDir(input.dir)
    const cn = typeof input.cn === 'string' ? input.cn.trim() : ''
    if (cn === '') throw new TemplateEditorError('样式模板名不能为空')
    const en = typeof input.en === 'string' ? input.en.trim() : ''
    const source = typeof input.source === 'string' ? input.source.trim() : ''
    if (source === '') throw new TemplateEditorError('没有选样式文件（.docx 或已解包的骨架目录）')
    const sourcePath = resolve(source)
    if (!existsSync(sourcePath)) {
      throw new TemplateEditorError(`选中的样式文件不存在：${sourcePath}`)
    }
    const styleFolder =
      typeof input.styleFolder === 'string' && input.styleFolder.trim() !== ''
        ? input.styleFolder.trim()
        : DEFAULT_SKELETON_FOLDER
    assertSafeFolderName(styleFolder, '骨架文件夹名')

    const uuid = newTemplateUuid()
    const idDir = join(dir, TEMPLATE_SUBDIR.style, uuid)
    const skeletonDir = join(idDir, styleFolder)
    const filePath = join(idDir, templateFileName(uuid))
    mkdirSync(idDir, { recursive: true })
    try {
      const stat = statSync(sourcePath)
      if (stat.isDirectory()) {
        cpSync(sourcePath, skeletonDir, { recursive: true })
      } else {
        await this.unpackDocx(sourcePath, skeletonDir)
      }

      // 必需部件：缺一个就报错，并把刚铺开的这半份收回去（不留半成品）
      const missing = SKELETON_REQUIRED_PARTS.filter(
        (part) => !existsSync(join(skeletonDir, part))
      )
      if (missing.length > 0) {
        throw new TemplateEditorError(
          `这份样式缺必需部件：${missing.join(' / ')}（.docx 至少要带 word/styles.xml、` +
            `word/numbering.xml、word/document.xml 与关系表）`
        )
      }
      const index = parseSkeletonIndex(skeletonDir)
      if (index.styleIds.length === 0) {
        throw new TemplateEditorError(
          `骨架 ${styleFolder}/word/styles.xml 里读不到任何 styleId，这份样式没法用`
        )
      }

      // 对照表草稿：按样式名认；认不出的留空
      const draft: StyleMapDraft = draftStyleMap({ styles: index.styles })
      const doc: Record<string, unknown> = {
        ...identityFields({ uuid, cn, en }),
        version: '1.0',
        description: '',
        docxFolder: styleFolder,
        styleMap: draft.styleMap
      }
      writeFileAtomic(filePath, serializeJson(doc, TEMPLATE_INDENT, '\n', true))

      return { style: this.readStyle({ dir, uuid }), draft }
    } catch (err) {
      // 任何一步没成就别把半份样式留在模板目录里
      try {
        rmSync(idDir, { recursive: true, force: true })
      } catch {
        // 回滚失败也不能盖掉真正的错误
      }
      throw err instanceof TemplateEditorError
        ? err
        : new TemplateEditorError(`导入样式失败：${messageOf(err)}`)
    }
  }

  /**
   * 把 `.docx`（就是个 zip）解包到目标目录。**只解包，一个字节的 XML 都不改**——
   * 样式是作者提供的资产，程序只读不写（PLAN-11 第 4 节第 1 条）。
   */
  private async unpackDocx(sourcePath: string, targetDir: string): Promise<void> {
    const zip = await JSZip.loadAsync(readFileSync(sourcePath))
    const base = resolve(targetDir)
    for (const [entryName, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue
      const target = resolve(join(base, entryName))
      // zip 里的条目名可以写 `..`：解包不许跑到目标目录外面去
      if (target !== base && !target.startsWith(base + sep)) {
        throw new TemplateEditorError(`docx 里的条目名越出目标目录：${entryName}`)
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, await entry.async('nodebuffer'))
    }
  }

  /**
   * 写回样式模板的对照表：与结构模板同一套（先校验，有 error 就抛不落盘；最后原子写）。
   * 写回只动 styleMap 与 captionNumbering 这些字段，
   * 其余字段与键顺序按解析后的顺序原样保留。
   */
  saveStyle(input: TemplateStyleSaveInput): TemplateStyleSaveResult {
    if (!isPlainObject(input.doc)) {
      throw new TemplateEditorError('保存内容必须是 JSON 对象')
    }
    const located = this.locate(input.dir, input.uuid, 'style')
    const issues = this.validateStyle(located, input.doc)
    const firstError = issues.find((i) => i.level === 'error')
    if (firstError) {
      throw new TemplateEditorError(
        `样式模板校验未通过，未写入（${firstError.path}）：${firstError.message}`
      )
    }
    this.writeDoc(located, input.doc)
    return { savedAt: localIsoNow(), issues: issues.map(toIssueDto) }
  }

  /**
   * 写回结构模板：先校验（有 error 就抛，不落盘），最后原子写。
   */
  save(input: TemplateSaveInput): TemplateSaveResult {
    if (!isPlainObject(input.doc)) {
      throw new TemplateEditorError('保存内容必须是 JSON 对象')
    }
    const located = this.locate(input.dir, input.uuid, 'structure')
    const issues = validateStructureTemplate(input.doc)
    const firstError = issues.find((i) => i.level === 'error')
    if (firstError) {
      throw new TemplateEditorError(
        `结构模板校验未通过，未写入（${firstError.path}）：${firstError.message}`
      )
    }
    this.writeDoc(located, input.doc)
    return { savedAt: localIsoNow(), issues: issues.map(toIssueDto) }
  }

  /** 新建结构模板：uuid 由程序生成，写一份最小可用的结构模板 JSON */
  create(input: TemplateCreateInput): TemplateReadResult {
    const dir = this.requireTemplateDir(input.dir)
    const cn = typeof input.cn === 'string' ? input.cn.trim() : ''
    if (cn === '') throw new TemplateEditorError('结构模板名不能为空')
    const en = typeof input.en === 'string' ? input.en.trim() : ''
    const defaultStyleUuid =
      typeof input.defaultStyleUuid === 'string' ? input.defaultStyleUuid.trim() : ''

    const uuid = newTemplateUuid()
    const doc: Record<string, unknown> = {
      ...identityFields({ uuid, cn, en }),
      version: '1.0',
      ...(defaultStyleUuid === '' ? {} : { defaultStyleUuid }),
      root: {
        nodeType: 'root',
        title: cn,
        headingLevel: 0,
        copyable: false,
        deletable: false,
        children: []
      }
    }
    const issues = validateStructureTemplate(doc)
    const firstError = issues.find((i) => i.level === 'error')
    if (firstError) {
      // 自造的模板不该带上 error：出现了就是实现跑偏，宁可失败也不要写出一份坏模板
      throw new TemplateEditorError(
        `新建的结构模板校验未通过，未写入（${firstError.path}）：${firstError.message}`
      )
    }

    const dirPath = join(dir, TEMPLATE_SUBDIR.structure, uuid)
    mkdirSync(dirPath, { recursive: true })
    writeFileAtomic(
      join(dirPath, templateFileName(uuid)),
      serializeJson(doc, TEMPLATE_INDENT, '\n', true)
    )
    return { dir, uuid, doc, issues: issues.map(toIssueDto) }
  }

  /**
   * 迁移旧格式模板目录（PLAN-12 §6）：目录名不是 uuid 的那些，分配 uuid、改目录与文件名、
   * 把结构里的样式引用换成样式 uuid，清单文件退场。旧格式不并存，迁完就没有旧目录了。
   *
   * 先样式后结构：结构的引用要按老的文件键换成新分配的样式 uuid，样式得先落地。
   * 一份失败只影响它自己——半份新目录撤掉，老目录留在原处，报出来让人自己处理。
   */
  migrate(input: TemplateMigrateInput): TemplateMigrateResult {
    const dir = this.requireTemplateDir(input.dir)
    const skipped: string[] = []
    const restyle: string[] = []
    /** 老的文件键与老 id → 新样式 uuid，结构那边按它换引用 */
    const styleUuidByKey = new Map<string, string>()
    let styles = 0
    let structures = 0

    for (const oldName of legacyDirsIn(join(dir, TEMPLATE_SUBDIR.style))) {
      const label = `${TEMPLATE_SUBDIR.style}/${oldName}`
      const oldDir = join(dir, TEMPLATE_SUBDIR.style, oldName)
      const file = legacyJsonFile(oldDir, oldName, 'stylemap')
      if (file === null) {
        skipped.push(`${label}：找不到样式模板 JSON`)
        continue
      }
      let doc: Record<string, unknown>
      try {
        doc = readJsonObjectFile('样式模板', label, file)
      } catch (err) {
        skipped.push(`${label}：${messageOf(err)}`)
        continue
      }
      if (!isPlainObject(doc['styleMap'])) {
        skipped.push(`${label}：没有 styleMap，不像一份样式模板`)
        continue
      }
      const uuid = newTemplateUuid()
      const identity = legacyIdentityOf(doc, oldName)
      const docxFolder = typeof doc['docxFolder'] === 'string' ? doc['docxFolder'] : ''
      const next: Record<string, unknown> = {
        ...identityFields({ uuid, cn: identity.cn, en: identity.en }),
        ...pickFields(doc, ['version', 'description']),
        ...(docxFolder === '' ? {} : { docxFolder }),
        styleMap: doc['styleMap'],
        ...pickFields(doc, ['captionNumbering'])
      }
      const newDir = join(dir, TEMPLATE_SUBDIR.style, uuid)
      try {
        mkdirSync(newDir, { recursive: true })
        // 骨架整份搬进来，一个字节都不改；新目录名是 uuid，所以骨架目录名照旧
        if (docxFolder !== '') {
          const skeletonOld = join(oldDir, docxFolder)
          if (existsSync(skeletonOld)) renameSync(skeletonOld, join(newDir, docxFolder))
        }
        writeFileAtomic(
          join(newDir, templateFileName(uuid)),
          serializeJson(next, TEMPLATE_INDENT, '\n', true)
        )
        rmSync(oldDir, { recursive: true, force: true })
      } catch (err) {
        rmSync(newDir, { recursive: true, force: true })
        skipped.push(`${label}：${messageOf(err)}`)
        continue
      }
      styles += 1
      const keys = [oldName, `${oldName}-stylemap`, `${oldName}-style`]
      if (typeof doc['name'] === 'string' && doc['name'].trim() !== '') keys.push(doc['name'].trim())
      for (const key of keys) styleUuidByKey.set(key, uuid)
    }

    for (const oldName of legacyDirsIn(join(dir, TEMPLATE_SUBDIR.structure))) {
      const label = `${TEMPLATE_SUBDIR.structure}/${oldName}`
      const oldDir = join(dir, TEMPLATE_SUBDIR.structure, oldName)
      const file = legacyJsonFile(oldDir, oldName, 'structure')
      if (file === null) {
        skipped.push(`${label}：找不到结构模板 JSON`)
        continue
      }
      let doc: Record<string, unknown>
      try {
        doc = readJsonObjectFile('结构模板', label, file)
      } catch (err) {
        skipped.push(`${label}：${messageOf(err)}`)
        continue
      }
      const root = isPlainObject(doc['root']) ? doc['root'] : null
      if (root === null) {
        skipped.push(`${label}：没有 root，不像一份结构模板`)
        continue
      }
      const uuid = newTemplateUuid()
      const identity = legacyIdentityOf(doc, oldName)
      // 老引用是文件键（`438c-sdd-stylemap`）：默认那份取 styleTemplate，可选集合按顺序找第一个认得的
      const declared = [
        typeof doc['styleTemplate'] === 'string' ? doc['styleTemplate'] : '',
        ...(Array.isArray(doc['styleTemplates'])
          ? doc['styleTemplates'].filter((key): key is string => typeof key === 'string')
          : [])
      ].find((key) => key !== '')
      const defaultStyleUuid = declared === undefined ? '' : (styleUuidByKey.get(declared) ?? '')
      const next: Record<string, unknown> = {
        ...identityFields({ uuid, cn: identity.cn, en: identity.en }),
        ...pickFields(doc, ['category', 'description', 'version']),
        defaultStyleUuid,
        root
      }
      const newDir = join(dir, TEMPLATE_SUBDIR.structure, uuid)
      try {
        mkdirSync(newDir, { recursive: true })
        writeFileAtomic(
          join(newDir, templateFileName(uuid)),
          serializeJson(next, TEMPLATE_INDENT, '\n', true)
        )
        rmSync(oldDir, { recursive: true, force: true })
      } catch (err) {
        rmSync(newDir, { recursive: true, force: true })
        skipped.push(`${label}：${messageOf(err)}`)
        continue
      }
      structures += 1
      if (declared !== undefined && defaultStyleUuid === '') {
        restyle.push(`${identity.cn}：旧文件里写的样式 ${declared} 不在这个目录里，默认样式留空待选`)
      }
    }

    const manifest = join(dir, MANIFEST_FILE)
    const manifestRemoved = existsSync(manifest) && statSync(manifest).isFile()
    if (manifestRemoved) rmSync(manifest, { force: true })
    return { structures, styles, manifestRemoved, skipped, restyle }
  }

  /** 删除结构模板：整份 `structures/<uuid>/` 一起删 */
  remove(input: TemplateDeleteInput): void {
    const located = this.locate(input.dir, input.uuid, 'structure')
    rmSync(located.dirPath, { recursive: true, force: true })
  }

  /**
   * 改结构模板的名字：只写自己那一个 JSON。
   * uuid 是身份、目录与文件名都按它来，改名不碰文件、不碰引用、不碰别的模板。
   */
  rename(input: TemplateRenameInput): TemplateReadResult {
    const located = this.locate(input.dir, input.uuid, 'structure')
    const { doc, renamed } = this.applyName(this.readDocOf(located), input)
    const issues = validateStructureTemplate(doc)
    if (renamed) {
      const firstError = issues.find((i) => i.level === 'error')
      if (firstError) {
        throw new TemplateEditorError(
          `结构模板校验未通过，未写入（${firstError.path}）：${firstError.message}`
        )
      }
      this.writeDoc(located, doc)
    }
    return { dir: located.dir, uuid: located.uuid, doc, issues: issues.map(toIssueDto) }
  }

  /** 删除样式模板：整份 `styles/<uuid>/`（含骨架）一起删 */
  removeStyle(input: TemplateDeleteInput): void {
    const located = this.locate(input.dir, input.uuid, 'style')
    rmSync(located.dirPath, { recursive: true, force: true })
  }

  /**
   * 改样式模板的名字：只写自己那一个 JSON，目录名与文件名都不动。
   * 结构按 uuid 引用这份样式，所以改名不会让任何引用对不上。
   */
  renameStyle(input: TemplateStyleRenameInput): TemplateStyleRenameResult {
    const located = this.locate(input.dir, input.uuid, 'style')
    const { doc, renamed } = this.applyName(this.readDocOf(located), input)
    const issues = this.validateStyle(located, doc)
    if (renamed) {
      const firstError = issues.find((i) => i.level === 'error')
      if (firstError) {
        throw new TemplateEditorError(
          `样式模板校验未通过，未写入（${firstError.path}）：${firstError.message}`
        )
      }
      this.writeDoc(located, doc)
    }
    return this.readStyle({ dir: located.dir, uuid: located.uuid })
  }

  // ---------- 内部 ----------

  /**
   * 改名的公共部分：中文名是主名必填，英文名是副名可留空；
   * 留空就把它从 JSON 里删掉（`identityFields` 也不写空值），返回是否真改了。
   */
  private applyName(
    doc: Record<string, unknown>,
    input: { cn: string; en?: string }
  ): { doc: Record<string, unknown>; renamed: boolean } {
    const cn = typeof input.cn === 'string' ? input.cn.trim() : ''
    if (cn === '') throw new TemplateEditorError('模板名不能为空')
    const en = typeof input.en === 'string' ? input.en.trim() : ''
    const currentEn = typeof doc['en'] === 'string' ? doc['en'] : ''
    const renamed = doc['cn'] !== cn || currentEn !== en
    if (renamed) {
      doc['cn'] = cn
      if (en === '') delete doc['en']
      else doc['en'] = en
    }
    return { doc, renamed }
  }

  /** 设置里配置的模板目录：去空白、转绝对路径、去重（顺序即界面顺序） */
  private templateDirList(): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of this.deps.templateDirs()) {
      if (typeof raw !== 'string' || raw.trim() === '') continue
      const dir = resolve(raw)
      if (seen.has(dir)) continue
      seen.add(dir)
      out.push(dir)
    }
    return out
  }

  /** 模板目录必须存在（不存在就没法读写，报出来比让 join 拼出怪路径清楚） */
  private requireTemplateDir(dir: string): string {
    if (typeof dir !== 'string' || dir.trim() === '') {
      throw new TemplateEditorError('模板目录不能为空')
    }
    const full = resolve(dir)
    if (!existsSync(full)) {
      throw new TemplateEditorError(`模板目录不存在：${full}`)
    }
    return full
  }

  /** 按 uuid 定位一份模板：目录名与文件名都是它，没有登记可查，也不需要查 */
  private locate(dir: string, uuid: string, kind: TemplateKind): LocatedTemplate {
    const root = this.requireTemplateDir(dir)
    assertTemplateUuid(uuid, kind === 'structure' ? '结构模板 uuid' : '样式模板 uuid')
    const dirPath = join(root, TEMPLATE_SUBDIR[kind], uuid)
    if (!existsSync(dirPath)) {
      throw new TemplateEditorError(`模板目录不存在：${TEMPLATE_SUBDIR[kind]}/${uuid}`)
    }
    return {
      kind,
      dir: root,
      uuid,
      dirPath,
      filePath: join(dirPath, templateFileName(uuid))
    }
  }

  /** 定位信息 → 出错时给人看的相对位置 */
  private labelOf(located: LocatedTemplate): string {
    return `${TEMPLATE_SUBDIR[located.kind]}/${located.uuid}/${templateFileName(located.uuid)}`
  }

  /** 读一份模板原文（结构或样式，按 located.kind 说话） */
  private readDocOf(located: LocatedTemplate): Record<string, unknown> {
    const what = located.kind === 'structure' ? '结构模板' : '样式模板'
    return readJsonObjectFile(what, this.labelOf(located), located.filePath)
  }

  /**
   * 骨架的事实：目录在不在、缺哪些必需部件、有哪些 styleId、可读样式表、起始编号。
   * 编辑模式要在本地跑同一套规则，所以事实随读结果一起给出去（`skeleton` 字段）。
   */
  private skeletonFacts(
    located: LocatedTemplate,
    docxFolder: string
  ): { dto: TemplateStyleSkeletonDto; styles: SkeletonStyleInfo[] } {
    const empty: TemplateStyleSkeletonDto = {
      folder: docxFolder,
      exists: false,
      missingParts: [],
      styleIds: []
    }
    if (docxFolder === '') return { dto: empty, styles: [] }
    const skeletonPath = join(located.dirPath, docxFolder)
    if (!existsSync(skeletonPath)) return { dto: empty, styles: [] }
    const missingParts = SKELETON_REQUIRED_PARTS.filter(
      (part) => !existsSync(join(skeletonPath, part))
    )
    const index = parseSkeletonIndex(skeletonPath)
    return {
      dto: {
        folder: docxFolder,
        exists: true,
        missingParts: [...missingParts],
        styleIds: index.styleIds,
        ...(index.headingStarts === undefined ? {} : { headingStarts: index.headingStarts })
      },
      styles: index.styles
    }
  }

  /** 把这份样式写成默认样式的结构模板（事实陈述，界面拿它提示"被谁共用"） */
  private structuresUsing(dir: string, styleUuid: string): TemplateStyleUserDto[] {
    const out: TemplateStyleUserDto[] = []
    for (const item of scanTemplateDir(dir).structures) {
      if (item.doc === null) continue
      if (text(item.doc['defaultStyleUuid'] ?? '') !== styleUuid) continue
      out.push({ uuid: item.uuid, name: item.name })
    }
    return out
  }

  /**
   * 原子写回模板。缩进与行尾都按原文件认（别猜），认不出退回 2 空格。
   * 不写 `.bak`：模板目录通常在版本控制里，可恢复性归 git。
   */
  private writeDoc(located: LocatedTemplate, doc: Record<string, unknown>): void {
    mkdirSync(located.dirPath, { recursive: true })
    const exists = existsSync(located.filePath)
    const raw = exists ? readFileSync(located.filePath, 'utf8') : ''
    const indent = exists ? detectIndent(raw) : TEMPLATE_INDENT
    writeFileAtomic(
      located.filePath,
      serializeJson(doc, indent, eolOf(located.filePath), exists ? /\r?\n$/u.test(raw) : true)
    )
  }

  /** 跑一份样式模板的规则（结论与界面上的徽标、保存前的闸门同一份） */
  private validateStyle(located: LocatedTemplate, doc: Record<string, unknown>): ValidationIssue[] {
    return validateStyleTemplate(doc, { basePath: located.dirPath })
  }
}

export function createTemplateEditorService(
  deps: TemplateEditorServiceDeps
): TemplateEditorService {
  return new TemplateEditorService(deps)
}
