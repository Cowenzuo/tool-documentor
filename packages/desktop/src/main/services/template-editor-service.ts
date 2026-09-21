/**
 * template-editor-service.ts — 模板编辑模式（PLAN-11 批次 1）的主进程服务：只动模板目录里的 JSON。
 *
 * 边界：
 *   - 不依赖工程库/数据库，不进撤销栈（编辑模式与文档会话是两套东西）；
 *   - 结构模板可读可写；样式模板可读（stylemap 原文、骨架样式表、按结构用法算出的对照表），
 *     写回与导入在批次 3 的后续步骤里接上；
 *   - 校验口径全部来自 `@documentor/templates` 的 validate：目录级用 `validateTemplateDir`，
 *     单份用 `validateStructureTemplate`，本文件不重写任何规则；
 *   - 写盘一律"先备份 → 写临时文件 → 改名覆盖"：任何一步失败都不留半截文件；
 *     备份落在**应用数据目录**的 `template-backups/` 下，不写进模板目录
 *     （模板目录通常受版本控制，不能让 .bak 污染别人的仓库）；
 *   - 序列化沿用现行模板的 2 空格缩进，字段顺序按解析后的插入顺序自然保留；
 *     若原文件是 CRLF（模板仓库里有一份就是），写回时保持 CRLF，免得整份文件行尾翻转。
 *
 * 依赖注入：模板目录列表与应用数据目录由调用方（ipc.ts）从应用设置与 Electron 取，
 * 于是本文件不 import electron，本机单测可以直接跑它。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { localIsoNow } from '@documentor/core/time'
import {
  SKELETON_REQUIRED_PARTS,
  buildStyleMapRows,
  parseSkeletonIndex,
  styleFactsOfStructure,
  styleFactsOfStructures,
  unusedSkeletonStyleIds,
  validateStructureTemplate,
  validateStyleTemplate,
  validateTemplateDir
} from '@documentor/templates'
import type { SkeletonStyleInfo, TemplateDirEntry, ValidationIssue } from '@documentor/templates'
import type {
  SkeletonStyleDto,
  StyleMapRowDto,
  TemplateCreateInput,
  TemplateDeleteInput,
  TemplateDeleteResult,
  TemplateDirSnapshotDto,
  TemplateEditorSnapshotDto,
  TemplateEntryDto,
  TemplateIssueDto,
  TemplateReadInput,
  TemplateReadResult,
  TemplateRenameInput,
  TemplateRenameResult,
  TemplateSaveInput,
  TemplateSaveResult,
  TemplateStyleReadInput,
  TemplateStyleReadResult,
  TemplateStyleSaveInput,
  TemplateStyleSaveResult,
  TemplateStyleSkeletonDto,
  TemplateStyleUserDto
} from '../../shared/project'

/** 服务层错误：ipc 的 handle() 会把 message 原样交给渲染层 */
export class TemplateEditorError extends Error {}

export interface TemplateEditorServiceDeps {
  /** 应用设置里的模板目录（settings.template_dirs），顺序即界面顺序 */
  templateDirs: () => string[]
  /** 应用数据目录（Electron userData）；备份落 `<它>/template-backups` */
  appDataDir: () => string
}

// ================= 常量 =================

const MANIFEST_FILE = 'manifest.json'
/** 目录名与 manifest 的键名同字面（模板仓库的硬约定）：structures/ 对 structures[]、styles/ 对 styles[] */
const STRUCTURES_DIR = 'structures'
const STYLES_DIR = 'styles'
const BACKUP_DIR = 'template-backups'
/** 结构模板 JSON 的缩进：现行模板全是 2 空格 */
const STRUCTURE_INDENT = 2
/** 新建 manifest 时的缩进：现行模板仓库的 manifest 是 4 空格 */
const DEFAULT_MANIFEST_INDENT = 4
/** manifest 没登记该 id 时按这个命名回落（模板仓库的约定） */
function structureFileName(id: string): string {
  return `${id}-structure.json`
}

// ================= 工具 =================

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 目录名合法性：必须是单段目录名（id 同时是目录名，读写都按它拼路径） */
const INVALID_DIR_NAME = /[\\/:*?"<>|\u0000-\u001f]/u
function assertSafeId(id: unknown, what: string): asserts id is string {
  if (
    typeof id !== 'string' ||
    id === '' ||
    id === '.' ||
    id === '..' ||
    INVALID_DIR_NAME.test(id) ||
    id.endsWith('.') ||
    id.endsWith(' ')
  ) {
    throw new TemplateEditorError(`${what}「${String(id)}」不是合法的目录名`)
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

/** 本地时间戳 `yyyyMMdd-HHmmss`（备份文件名用，本地时区，便于和用户的钟对上） */
function backupStamp(date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/**
 * 备份目录名：`<模板目录名>-<完整路径哈希前 8 位>`。
 * 带上哈希是因为不同位置的同名目录（例如多个仓库里都叫 packages）必须分开；
 * 带上目录名是因为出问题时要能在文件管理器里一眼认出来。
 */
function backupFolderName(dir: string): string {
  const full = resolve(dir)
  const readable = basename(full).replace(/[^0-9A-Za-z._-]+/gu, '_') || 'templates'
  const hash = createHash('sha256').update(full).digest('hex').slice(0, 8)
  return `${readable}-${hash}`
}

/** 同一秒内连写两次时不让后一次盖掉前一次：撞名就补 `-1`、`-2`… */
function uniquePath(path: string): string {
  if (!existsSync(path)) return path
  const stem = path.replace(/\.bak$/u, '')
  for (let n = 1; n < 1000; n++) {
    const next = `${stem}-${n}.bak`
    if (!existsSync(next)) return next
  }
  return `${stem}-${Date.now()}.bak`
}

/** 校验结论原样就是 IPC 的 DTO（同形状），这里只做一次显式转换，防止两边字段名漂移 */
function toIssueDto(issue: ValidationIssue): TemplateIssueDto {
  return { level: issue.level, rule: issue.rule, path: issue.path, message: issue.message }
}

function toEntryDto(entry: TemplateDirEntry): TemplateEntryDto {
  const errors = entry.issues.filter((i) => i.level === 'error').length
  return {
    kind: entry.kind,
    id: entry.id,
    name: entry.name,
    file: entry.file,
    errors,
    warnings: entry.issues.length - errors,
    issues: entry.issues.map(toIssueDto)
  }
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

/** 与 `@documentor/templates` 同法：任意 JSON 值按 JS 插值语义转成文案 */
function text(value: unknown): string {
  return String(value)
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

/** 目录"可用"的判据：存在且 manifest 能解析（编辑模式默认打开它） */
function isUsableDir(issues: readonly ValidationIssue[], exists: boolean): boolean {
  if (!exists) return false
  return !issues.some((i) => i.rule === 'dir.manifest.missing' || i.rule === 'dir.manifest.parse')
}

// ================= manifest 状态 =================

type ManifestState =
  | {
      status: 'ok'
      path: string
      doc: Record<string, unknown>
      indent: number | string
      eol: string
      trailingNewline: boolean
    }
  | { status: 'missing'; path: string }
  | { status: 'broken'; path: string; reason: string }

/** 从原文里认缩进宽度（看第一个缩进行）；认不出按 2 空格 */
function detectIndent(raw: string): number | string {
  const m = /^[^\n]*\n([ \t]+)"/u.exec(raw)
  const pad = m?.[1]
  if (pad === undefined) return DEFAULT_MANIFEST_INDENT
  return pad.includes('\t') ? '\t' : pad.length
}

/** 读 manifest：读不到/坏掉都返回状态，不抛（编辑模式要能报"为什么打不开"） */
function readManifest(dir: string): ManifestState {
  const path = join(dir, MANIFEST_FILE)
  if (!existsSync(path)) return { status: 'missing', path }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return { status: 'broken', path, reason: messageOf(err) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch (err) {
    return { status: 'broken', path, reason: messageOf(err) }
  }
  if (!isPlainObject(parsed)) return { status: 'broken', path, reason: '顶层不是对象' }
  return {
    status: 'ok',
    path,
    doc: parsed,
    indent: detectIndent(raw),
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
    trailingNewline: /\r?\n$/u.test(raw)
  }
}

/**
 * 写回 manifest：保留原缩进、行尾与"末尾有没有换行"，字段顺序按解析后的插入顺序。
 * manifest 不存在时从 `{ structures: [], styles: [] }` 起一份（4 空格缩进，与现行仓库一致）。
 */
function writeManifest(dir: string, state: ManifestState, doc: Record<string, unknown>): void {
  if (state.status === 'broken') {
    throw new TemplateEditorError(`manifest.json 解析失败，未改动清单：${state.reason}`)
  }
  const indent = state.status === 'ok' ? state.indent : DEFAULT_MANIFEST_INDENT
  const eol = state.status === 'ok' ? state.eol : '\n'
  const trailing = state.status === 'ok' ? state.trailingNewline : true
  writeFileAtomic(join(dir, MANIFEST_FILE), serializeJson(doc, indent, eol, trailing))
}

/** manifest 里的一份结构条目（写入时保持现行字段形状：id/name/category/description/file） */
interface ManifestStructureEntry {
  id: string
  name: string
  category: string
  description: string
  file: string
}

/** manifest 里的样式条目（与真实仓库同形：id / name / description / stylemap_file / style_folder） */
interface ManifestStyleEntry {
  id: string
  name: string
  description: string
  stylemapFile: string
  styleFolder: string
}

// ================= 定位 =================

/**
 * 一份模板文件的最小定位信息（结构模板与样式模板共用）：
 * 备份只用到这四处，所以备份那一段不关心眼前是结构还是样式。
 */
interface LocatedFile {
  /** 模板目录（绝对路径） */
  dir: string
  /** 模板 id（= 目录名） */
  id: string
  /** 文件名（结构是 `<id>-structure.json`，样式是 manifest 里的 stylemap_file） */
  file: string
  /** 文件绝对路径 */
  filePath: string
}

interface LocatedStructure extends LocatedFile {
  /** 文件名是 manifest 给的还是按约定回落的（出错时要说清是按哪个名字找的） */
  fileFromManifest: boolean
  /** `structures/<id>` 绝对路径 */
  dirPath: string
  /** manifest 里的 name（有才传，用于"清单名与文件内 name 不一致"的告警） */
  manifestName: string
  manifest: ManifestState
}

/**
 * 定位 `styles/<id>/<stylemap_file>`：样式那份**没有**文件名约定，名字只能来自 manifest
 * （结构侧还能按 `<id>-structure.json` 回落，样式侧的 fileKey 与目录名并不总是一致）。
 * 所以 manifest 里没这条登记时直接报错，不猜。
 */
interface LocatedStyle extends LocatedFile {
  /** 引用它时写的 key：文件名去掉 .json */
  fileKey: string
  /** `styles/<id>` 绝对路径 */
  dirPath: string
  /** manifest 里的 name */
  manifestName: string
  /** manifest 里的 style_folder（与 stylemap 的 docxFolder 不一致时要告警） */
  manifestStyleFolder: string
  manifest: ManifestState
}

// ================= 服务 =================

export class TemplateEditorService {
  constructor(private readonly deps: TemplateEditorServiceDeps) {}

  /**
   * 打开编辑模式时的全貌：设置里在用的模板目录逐个校验，给出目录级问题与模板列表。
   * `defaultDir` 取第一个"可用"的目录（存在且 manifest 能解析），没有就是 null。
   */
  snapshot(): TemplateEditorSnapshotDto {
    const dirs: TemplateDirSnapshotDto[] = []
    let defaultDir: string | null = null
    for (const dir of this.templateDirList()) {
      const validation = validateTemplateDir(dir)
      dirs.push({
        dir: validation.dir,
        exists: validation.exists,
        issues: validation.issues.map(toIssueDto),
        structures: validation.structures.map(toEntryDto),
        styles: validation.styles.map(toEntryDto)
      })
      if (defaultDir === null && isUsableDir(validation.issues, validation.exists)) {
        defaultDir = validation.dir
      }
    }
    return { defaultDir, dirs }
  }

  /** 读一份结构模板原文：file 从 manifest 取，没登记就按 `<id>-structure.json` 回落 */
  read(input: TemplateReadInput): TemplateReadResult {
    const located = this.locateStructure(input.dir, input.id)
    const doc = this.readStructureDoc(located)
    return {
      dir: located.dir,
      id: located.id,
      file: located.file,
      doc,
      issues: this.validate(located, doc)
    }
  }

  /**
   * 读一份样式模板（PLAN-11 批次 3）：stylemap 原文 + 骨架样式表 + 对照表。
   *
   * 对照表里的"必需"不是把逻辑键一刀切，而是按**引用这份对照表的结构模板实际用到的块**
   * 推导（`requiredStyleKeys`）：有表格才要 `table.*`，有图才要 `figure.caption`。
   * 共用影响面（`usedBy`）与必需键用的是同一个引用口径（`styleTemplateKeys`，
   * 加载器 `def.styleTemplates` 的"缺省回退为 [styleTemplate]"）。
   *
   * `issues` 是 `validateStyleTemplate` 的原话，与模板列表里的徽标、保存前的闸门同一份；
   * `rows` 只是它的逐行视图，两者看的是同一份 styleMap 与同一个骨架索引。
   */
  readStyle(input: TemplateStyleReadInput): TemplateStyleReadResult {
    const located = this.locateStyle(input.dir, input.id)
    const doc = this.readStyleDoc(located)
    const structureDocs = this.loadStructureDocs(located.dir)
    const facts = styleFactsOfStructures(structureDocs.map((s) => s.doc))
    /** 引用这份对照表的结构 + 它们的诉求（按 manifest 顺序） */
    const usedBy: TemplateStyleUserDto[] = []
    for (const s of structureDocs) {
      const fact = styleFactsOfStructure(s.doc)
      if (!fact || !fact.fileKeys.includes(located.fileKey)) continue
      usedBy.push({
        id: s.id,
        name: s.name,
        isDefault: text(s.doc['styleTemplate'] ?? '') === located.fileKey,
        requiredKeys: fact.keys,
        captions: fact.captions
      })
    }

    const docxFolder = typeof doc['docxFolder'] === 'string' ? doc['docxFolder'] : ''
    const skeletonPath = docxFolder === '' ? located.dirPath : join(located.dirPath, docxFolder)
    const skeleton = this.skeletonFacts(located, docxFolder)
    const skeletonStyles = skeleton.styles
    const styleMap = isPlainObject(doc['styleMap']) ? doc['styleMap'] : {}

    const rows: StyleMapRowDto[] = buildStyleMapRows({
      styleMap,
      requirements: usedBy.map((u) => ({ name: u.name, keys: u.requiredKeys })),
      skeletonStyleIds: skeleton.dto.styleIds.length > 0 ? skeleton.dto.styleIds : null,
      skeletonStyles
    })

    return {
      dir: located.dir,
      id: located.id,
      file: located.file,
      fileKey: located.fileKey,
      doc,
      skeletonPath,
      skeletonExists: skeleton.dto.exists,
      skeleton: skeleton.dto,
      manifestStyleFolder: located.manifestStyleFolder,
      skeletonStyles: skeletonStyles.map(toSkeletonStyleDto),
      unusedStyleIds: unusedSkeletonStyleIds(styleMap, skeletonStyles),
      rows,
      usedBy,
      issues: validateStyleTemplate(doc, structureDocs.map((s) => s.doc), {
        id: located.id,
        stylemapFile: located.file,
        basePath: located.dirPath,
        manifestStyleFolder: located.manifestStyleFolder || undefined
      }).map(toIssueDto)
    }
  }

  /**
   * 写回样式模板的对照表：与结构模板同一套（先校验，有 error 就抛不落盘；
   * 再备份原文件，最后原子写）。写回只动 styleMap 与 captionNumbering 这些字段，
   * 其余字段与键顺序按解析后的顺序原样保留。
   */
  saveStyle(input: TemplateStyleSaveInput): TemplateStyleSaveResult {
    if (!isPlainObject(input.doc)) {
      throw new TemplateEditorError('保存内容必须是 JSON 对象')
    }
    const located = this.locateStyle(input.dir, input.id)
    const structureDocs = this.loadStructureDocs(located.dir)
    const issues = validateStyleTemplate(input.doc, structureDocs.map((s) => s.doc), {
      id: located.id,
      stylemapFile: located.file,
      basePath: located.dirPath,
      manifestStyleFolder: located.manifestStyleFolder || undefined
    })
    const firstError = issues.find((i) => i.level === 'error')
    if (firstError) {
      throw new TemplateEditorError(
        `样式模板校验未通过，未写入（${firstError.path}）：${firstError.message}`
      )
    }
    const backupPath = this.writeStyleDoc(located, input.doc)
    return { savedAt: localIsoNow(), backupPath, issues: issues.map(toIssueDto) }
  }

  /**
   * 写回结构模板：先校验（有 error 就抛，不落盘），再备份原文件，最后原子写。
   * `backupPath` 首次保存（原文件还不存在）时为 null。
   */
  save(input: TemplateSaveInput): TemplateSaveResult {
    if (!isPlainObject(input.doc)) {
      throw new TemplateEditorError('保存内容必须是 JSON 对象')
    }
    const located = this.locateStructure(input.dir, input.id)
    const issues = this.validate(located, input.doc)
    const firstError = issues.find((i) => i.level === 'error')
    if (firstError) {
      throw new TemplateEditorError(
        `结构模板校验未通过，未写入（${firstError.path}）：${firstError.message}`
      )
    }
    const backupPath = this.writeStructure(located, input.doc)
    return { savedAt: localIsoNow(), backupPath, issues: issues.map(toIssueDto) }
  }

  /**
   * 新建结构模板：建 `structures/<id>/`，写一份最小可用的结构模板 JSON，
   * 并按现行 manifest 的形状追加一条登记（只在新建与删除时同步清单，编辑不动它）。
   */
  create(input: TemplateCreateInput): TemplateReadResult {
    const dir = this.requireTemplateDir(input.dir)
    assertSafeId(input.id, '结构模板 id')
    const id = input.id
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name === '') throw new TemplateEditorError('结构模板名不能为空')
    const styleTemplate = typeof input.styleTemplate === 'string' ? input.styleTemplate.trim() : ''

    const manifest = readManifest(dir)
    if (manifest.status === 'broken') {
      throw new TemplateEditorError(`manifest.json 解析失败，未新建模板：${manifest.reason}`)
    }
    const declared = this.declaredStructureEntries(manifest)
    const dirPath = join(dir, STRUCTURES_DIR, id)
    if (declared.some((e) => e.id === id) || existsSync(dirPath)) {
      throw new TemplateEditorError(`结构模板 id「${id}」已存在（目录里或 manifest 里已有）`)
    }

    const file = structureFileName(id)
    const doc: Record<string, unknown> = {
      name,
      version: '1.0',
      ...(styleTemplate === '' ? {} : { styleTemplate }),
      root: {
        nodeType: 'root',
        title: name,
        headingLevel: 0,
        copyable: false,
        deletable: false,
        children: []
      }
    }
    const located: LocatedStructure = {
      dir,
      id,
      file,
      fileFromManifest: false,
      dirPath,
      filePath: join(dirPath, file),
      manifestName: name,
      manifest
    }
    const issues = this.validate(located, doc)
    const firstError = issues.find((i) => i.level === 'error')
    if (firstError) {
      // 自造的模板不该带上 error：出现了就是实现跑偏，宁可失败也不要写出一份坏模板
      throw new TemplateEditorError(
        `新建的结构模板校验未通过，未写入（${firstError.path}）：${firstError.message}`
      )
    }

    mkdirSync(dirPath, { recursive: true })
    writeFileAtomic(located.filePath, serializeJson(doc, STRUCTURE_INDENT, '\n', true))
    try {
      const nextManifest: Record<string, unknown> =
        manifest.status === 'ok'
          ? { ...manifest.doc }
          : { [STRUCTURES_DIR]: [], [STYLES_DIR]: [] }
      const entries = Array.isArray(nextManifest[STRUCTURES_DIR])
        ? nextManifest[STRUCTURES_DIR]
        : []
      // 现行 manifest 的结构条目就是这五个字段；新条目字段顺序与它们一致
      const entry: ManifestStructureEntry = {
        id,
        name,
        category: '',
        description: '',
        file
      }
      nextManifest[STRUCTURES_DIR] = [...entries, entry]
      if (!Array.isArray(nextManifest[STYLES_DIR])) nextManifest[STYLES_DIR] = []
      writeManifest(dir, manifest, nextManifest)
    } catch (err) {
      // 清单没写成，别把已经建出来的目录留在模板目录里
      try {
        rmSync(dirPath, { recursive: true, force: true })
      } catch {
        // 回滚失败也不能盖掉真正的错误
      }
      throw err
    }

    return { dir, id, file, doc, issues: issues.map(toIssueDto) }
  }

  /** 删除结构模板：整份 `structures/<id>/` 先备份，再删目录，最后从 manifest 移除该条 */
  remove(input: TemplateDeleteInput): TemplateDeleteResult {
    const located = this.locateStructure(input.dir, input.id)
    if (located.manifest.status === 'broken') {
      // 清单坏着就删，会留下一条指向空目录的登记：先让作者把清单修好
      throw new TemplateEditorError(
        `manifest.json 解析失败，未删除模板（先修好清单）：${located.manifest.reason}`
      )
    }
    if (!existsSync(located.dirPath)) {
      throw new TemplateEditorError(`结构模板目录不存在：${STRUCTURES_DIR}/${located.id}`)
    }

    const backupPath = this.backupStructureDir(located)
    rmSync(located.dirPath, { recursive: true, force: true })

    if (located.manifest.status === 'ok') {
      const manifest = located.manifest
      const rawEntries = Array.isArray(manifest.doc[STRUCTURES_DIR])
        ? (manifest.doc[STRUCTURES_DIR] as unknown[])
        : []
      const hasEntry = rawEntries.some((raw) => isPlainObject(raw) && raw['id'] === located.id)
      // 清单里本来就没有这条（例如从未登记）时不动 manifest：删除不该顺手改别的东西
      if (hasEntry) {
        const kept = rawEntries.filter((raw) => {
          const entry = isPlainObject(raw) ? raw : null
          return !(entry && entry['id'] === located.id)
        })
        writeManifest(located.dir, manifest, { ...manifest.doc, [STRUCTURES_DIR]: kept })
      }
    }
    return { backupPath }
  }

  /**
   * 改结构模板：`name` 是 JSON 里的显示名，`newId` 是 id（目录名）。
   * - 只改 name：与以前一样，只动 JSON，目录名与文件名不动；
   * - 带 newId：`structures/<id>/` → `structures/<newId>/`、`<id>-structure.json` →
   *   `<newId>-structure.json`、manifest 里那条的 id/file 一起改，改动前整份目录先备份。
   *   工程锚点按 **name** 认模板（`documentor.dproj` 的 template 字段），工程侧不存 id，
   *   所以改 id 不影响已建工程；改 name 才会让老工程配不上模板。
   */
  rename(input: TemplateRenameInput): TemplateRenameResult {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name === '') throw new TemplateEditorError('结构模板名不能为空')
    const located = this.locateStructure(input.dir, input.id)
    const newId = typeof input.newId === 'string' ? input.newId.trim() : ''

    let target = located
    let backupPath: string | null = null
    if (newId !== '' && newId !== located.id) {
      const moved = this.moveStructureId(located, newId)
      target = moved.located
      backupPath = moved.backupPath
    }

    const doc = this.readStructureDoc(target)
    // 名称变了才写回；校验用的是**改完 name 之后**的文档（结论要反映改后的状态）
    const renamed = doc['name'] !== name
    if (renamed) doc['name'] = name
    const issues = this.validate(target, doc)
    if (renamed) {
      const firstError = issues.find((i) => i.level === 'error')
      if (firstError) {
        throw new TemplateEditorError(
          `结构模板校验未通过，未写入（${firstError.path}）：${firstError.message}`
        )
      }
      // 注意：写文件这一步不能被上面的 ?? 短路掉——改 id 时 backupPath 已经有值，
      // 但 JSON 该写还是要写
      const fileBackupPath = this.writeStructure(target, doc)
      backupPath = backupPath ?? fileBackupPath
    }
    return {
      dir: target.dir,
      id: target.id,
      file: target.file,
      doc,
      issues: issues.map(toIssueDto),
      backupPath
    }
  }

  /**
   * 换 id：目录改名 + 文件改名 + manifest 登记同步，改前整份备份。
   * 清单没写成时尽量把目录挪回去，别留下"登记指向不存在目录"的模板。
   */
  private moveStructureId(
    located: LocatedStructure,
    newId: string
  ): { located: LocatedStructure; backupPath: string } {
    assertSafeId(newId, '新的结构模板 id')
    if (located.manifest.status === 'broken') {
      throw new TemplateEditorError(
        `manifest.json 解析失败，未改 id（先修好清单）：${located.manifest.reason}`
      )
    }
    if (!existsSync(located.dirPath)) {
      throw new TemplateEditorError(`结构模板目录不存在：${STRUCTURES_DIR}/${located.id}`)
    }
    const newDirPath = join(located.dir, STRUCTURES_DIR, newId)
    if (existsSync(newDirPath)) {
      throw new TemplateEditorError(`目录已存在，未改 id：${STRUCTURES_DIR}/${newId}`)
    }
    if (this.declaredStructureEntries(located.manifest).some((e) => e.id === newId)) {
      throw new TemplateEditorError(`manifest 里已经登记了 id 为「${newId}」的模板，未改 id`)
    }

    const backupPath = this.backupStructureDir(located, '未改名')
    const newFile = structureFileName(newId)
    try {
      renameSync(located.dirPath, newDirPath)
      if (located.file !== newFile) {
        renameSync(join(newDirPath, located.file), join(newDirPath, newFile))
      }
      if (located.manifest.status === 'ok') {
        const manifest = located.manifest
        const rawEntries = Array.isArray(manifest.doc[STRUCTURES_DIR])
          ? (manifest.doc[STRUCTURES_DIR] as unknown[])
          : []
        const hasEntry = rawEntries.some((raw) => isPlainObject(raw) && raw['id'] === located.id)
        if (hasEntry) {
          // 只换 id 与 file 两个值：其余字段与键顺序原样保留（展开对象的键序不变）
          const next = rawEntries.map((raw) =>
            isPlainObject(raw) && raw['id'] === located.id
              ? { ...raw, id: newId, file: newFile }
              : raw
          )
          writeManifest(located.dir, manifest, { ...manifest.doc, [STRUCTURES_DIR]: next })
        }
      }
    } catch (err) {
      try {
        if (!existsSync(located.dirPath) && existsSync(newDirPath)) {
          renameSync(newDirPath, located.dirPath)
        }
      } catch {
        // 回滚失败也不能盖掉真正的错误
      }
      throw err instanceof TemplateEditorError
        ? err
        : new TemplateEditorError(`改 id 失败：${messageOf(err)}`)
    }

    return {
      located: {
        ...located,
        id: newId,
        file: newFile,
        fileFromManifest: false,
        dirPath: newDirPath,
        filePath: join(newDirPath, newFile)
      },
      backupPath
    }
  }

  // ---------- 内部 ----------

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

  private declaredStructureEntries(manifest: ManifestState): ManifestStructureEntry[] {
    if (manifest.status !== 'ok') return []
    const raw = manifest.doc[STRUCTURES_DIR]
    if (!Array.isArray(raw)) return []
    return raw.filter(isPlainObject).flatMap((e) => {
      const id = typeof e['id'] === 'string' ? e['id'] : ''
      const file = typeof e['file'] === 'string' ? e['file'] : ''
      if (id === '' || file === '') return []
      return [
        {
          id,
          name: typeof e['name'] === 'string' ? e['name'] : '',
          category: typeof e['category'] === 'string' ? e['category'] : '',
          description: typeof e['description'] === 'string' ? e['description'] : '',
          file
        }
      ]
    })
  }

  /** 定位 `structures/<id>/<file>`：file 取 manifest，没有登记就用约定名 */
  private locateStructure(dir: string, id: string): LocatedStructure {
    const root = this.requireTemplateDir(dir)
    assertSafeId(id, '结构模板 id')
    const manifest = readManifest(root)
    const entry = this.declaredStructureEntries(manifest).find((e) => e.id === id)
    const file = entry?.file || structureFileName(id)
    const dirPath = join(root, STRUCTURES_DIR, id)
    const filePath = join(dirPath, file)
    // manifest 的 file 理论上是文件名：万一写了 `..\..\x.json` 也不能让它跑出模板目录
    const base = resolve(dirPath)
    if (resolve(filePath) !== base && !resolve(filePath).startsWith(base + sep)) {
      throw new TemplateEditorError(`manifest 登记的 file 越出模板目录：structures/${id}/${file}`)
    }
    return {
      dir: root,
      id,
      file,
      fileFromManifest: entry !== undefined,
      dirPath,
      filePath,
      manifestName: entry?.name ?? '',
      manifest
    }
  }

  /** 读一份结构模板原文（读不到 / 不是对象都抛，消息里带上按哪个名字找的） */
  private readStructureDoc(located: LocatedStructure): Record<string, unknown> {
    const label = `${STRUCTURES_DIR}/${located.id}/${located.file}`
    const hint = located.fileFromManifest
      ? ''
      : '（manifest 里没有该 id 的登记，按 <id>-structure.json 找的）'
    return readJsonObjectFile('结构模板', label, located.filePath, hint)
  }

  /** manifest 里的样式条目（与结构条目同一套口径：缺 id 或缺文件名的整条丢掉） */
  private declaredStyleEntries(manifest: ManifestState): ManifestStyleEntry[] {
    if (manifest.status !== 'ok') return []
    const raw = manifest.doc[STYLES_DIR]
    if (!Array.isArray(raw)) return []
    return raw.filter(isPlainObject).flatMap((e) => {
      const id = typeof e['id'] === 'string' ? e['id'] : ''
      const stylemapFile = typeof e['stylemap_file'] === 'string' ? e['stylemap_file'] : ''
      if (id === '' || stylemapFile === '') return []
      return [
        {
          id,
          name: typeof e['name'] === 'string' ? e['name'] : '',
          description: typeof e['description'] === 'string' ? e['description'] : '',
          stylemapFile,
          styleFolder: typeof e['style_folder'] === 'string' ? e['style_folder'] : ''
        }
      ]
    })
  }

  /**
   * 定位 `styles/<id>/<stylemap_file>`：文件名只能从 manifest 取（样式侧没有命名约定），
   * 所以没登记就报错，不猜文件名。
   */
  private locateStyle(dir: string, id: string): LocatedStyle {
    const root = this.requireTemplateDir(dir)
    assertSafeId(id, '样式模板 id')
    const manifest = readManifest(root)
    if (manifest.status === 'broken') {
      throw new TemplateEditorError(
        `manifest.json 解析失败，读不到样式文件登记（先修好清单）：${manifest.reason}`
      )
    }
    const entry = this.declaredStyleEntries(manifest).find((e) => e.id === id)
    if (!entry) {
      throw new TemplateEditorError(
        `manifest.styles 里没有 id 为「${id}」的登记：样式文件名只能从清单取，没法按约定猜`
      )
    }
    const dirPath = join(root, STYLES_DIR, id)
    const filePath = join(dirPath, entry.stylemapFile)
    // manifest 的 stylemap_file 理论上是文件名：写了 `..\..\x.json` 也不能让它跑出模板目录
    const base = resolve(dirPath)
    if (resolve(filePath) !== base && !resolve(filePath).startsWith(base + sep)) {
      throw new TemplateEditorError(
        `manifest 登记的 stylemap_file 越出模板目录：styles/${id}/${entry.stylemapFile}`
      )
    }
    return {
      dir: root,
      id,
      file: entry.stylemapFile,
      fileKey: entry.stylemapFile.replace(/\.json$/u, ''),
      dirPath,
      filePath,
      manifestName: entry.name,
      manifestStyleFolder: entry.styleFolder,
      manifest
    }
  }

  /** 读一份样式模板原文 */
  private readStyleDoc(located: LocatedStyle): Record<string, unknown> {
    return readJsonObjectFile(
      '样式模板',
      `${STYLES_DIR}/${located.id}/${located.file}`,
      located.filePath
    )
  }

  /**
   * 骨架的事实：目录在不在、缺哪些必需部件、有哪些 styleId、可读样式表、起始编号。
   * 编辑模式要在本地跑同一套规则，所以事实随读结果一起给出去（`skeleton` 字段）。
   */
  private skeletonFacts(
    located: LocatedStyle,
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

  /** 备份原文件并原子写回样式模板；返回备份路径（原文件不存在时是 null） */
  private writeStyleDoc(located: LocatedStyle, doc: Record<string, unknown>): string | null {
    mkdirSync(located.dirPath, { recursive: true })
    const exists = existsSync(located.filePath)
    const backupPath = exists ? this.backupFile(located) : null
    const raw = exists ? readFileSync(located.filePath, 'utf8') : ''
    // 缩进与行尾都按原文件认（真实 stylemap 是 2 空格，但别猜）：认不出退回结构那一套
    const indent = exists ? detectIndent(raw) : STRUCTURE_INDENT
    writeFileAtomic(
      located.filePath,
      serializeJson(doc, indent, eolOf(located.filePath), exists ? /\r?\n$/u.test(raw) : true)
    )
    return backupPath
  }

  /**
   * 读模板目录里全部能读出来的结构模板原文（算"必需样式键"与"共用影响面"的输入）。
   * 读不出来的那份直接跳过：那是目录级校验要报的事，这里只是算必需键的原料，
   * 不该因为它把整份样式读不出来。
   */
  private loadStructureDocs(
    dir: string
  ): Array<{ id: string; name: string; doc: Record<string, unknown> }> {
    const manifest = readManifest(dir)
    if (manifest.status !== 'ok') return []
    const out: Array<{ id: string; name: string; doc: Record<string, unknown> }> = []
    for (const entry of this.declaredStructureEntries(manifest)) {
      const itemDir = join(dir, STRUCTURES_DIR, entry.id)
      const filePath = join(itemDir, entry.file)
      if (resolve(filePath) !== resolve(itemDir) && !resolve(filePath).startsWith(resolve(itemDir) + sep)) {
        continue
      }
      let doc: Record<string, unknown>
      try {
        doc = readJsonObjectFile('结构模板', `${STRUCTURES_DIR}/${entry.id}/${entry.file}`, filePath)
      } catch {
        continue
      }
      const name = typeof doc['name'] === 'string' && doc['name'] !== '' ? doc['name'] : entry.name || entry.id
      out.push({ id: entry.id, name, doc })
    }
    return out
  }

  private validate(located: LocatedStructure, doc: Record<string, unknown>): ValidationIssue[] {
    return validateStructureTemplate(doc, {
      id: located.id,
      file: located.file,
      manifestName: located.manifestName || undefined
    })
  }

  /** 备份原文件并原子写回；返回备份路径（原文件不存在时是 null） */
  private writeStructure(located: LocatedStructure, doc: Record<string, unknown>): string | null {
    mkdirSync(located.dirPath, { recursive: true })
    const backupPath = existsSync(located.filePath) ? this.backupFile(located) : null
    const eol = eolOf(located.filePath)
    writeFileAtomic(located.filePath, serializeJson(doc, STRUCTURE_INDENT, eol, true))
    return backupPath
  }

  /** 备份根目录：应用数据目录下的 `template-backups` */
  private backupRoot(): string {
    const base = this.deps.appDataDir()
    if (typeof base !== 'string' || base.trim() === '') {
      throw new TemplateEditorError('取不到应用数据目录，无法备份，未写入')
    }
    return join(resolve(base), BACKUP_DIR)
  }

  /** 单文件备份：`<备份根>/<目录名>-<路径哈希>/<文件名>-<yyyyMMdd-HHmmss>.bak` */
  private backupFile(located: LocatedFile): string {
    const folder = join(this.backupRoot(), backupFolderName(located.dir))
    mkdirSync(folder, { recursive: true })
    const target = uniquePath(join(folder, `${located.file}-${backupStamp()}.bak`))
    try {
      copyFileSync(located.filePath, target)
    } catch (err) {
      throw new TemplateEditorError(`备份失败，未写入：${target}：${messageOf(err)}`)
    }
    return target
  }

  /** 整目录备份（删除与改 id 用）：`<备份根>/<目录名>-<路径哈希>/<id>-<yyyyMMdd-HHmmss>.bak/` */
  private backupStructureDir(located: LocatedStructure, what = '未删除'): string {
    const folder = join(this.backupRoot(), backupFolderName(located.dir))
    mkdirSync(folder, { recursive: true })
    const target = uniquePath(join(folder, `${located.id}-${backupStamp()}.bak`))
    try {
      cpSync(located.dirPath, target, { recursive: true })
    } catch (err) {
      throw new TemplateEditorError(`备份失败，${what}：${target}：${messageOf(err)}`)
    }
    return target
  }
}

export function createTemplateEditorService(
  deps: TemplateEditorServiceDeps
): TemplateEditorService {
  return new TemplateEditorService(deps)
}
