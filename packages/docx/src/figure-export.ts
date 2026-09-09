/**
 * figure-export.ts — M7 图嵌入链路编排（Mermaid → VSDX → OLE 嵌入 docx）。
 *
 * 分工（分层约定，2025 修订）：
 *   - **预览图属于“图转换”的产物**：由 mmd2vsdx 工程产出（与 VSDX 同源同风格）。
 *     本工程假定“预备的 VSDX 就是交付格式”，若转换结果**附带**预览（previewBase64）
 *     或暂存区存在同名预览文件则嵌入 v:imagedata；什么都没有 → 回退为无预览嵌入
 *     （Word 显示 OLE 图标），不报错、不中断；
 *   - mmd2vsdx 保持“上游工具包”（link: 依赖，不 vendored、不打补丁）——只在本模块
 *     通过动态 import 调用其 application.convertText（可注入 convert 便于测试）；
 *   - @documentor/postprocess 负责 OLE/CF 容器与 OOXML 装配（字节级）；
 *   - 本模块编排：按文档顺序收集图块 → 逐图转换（可选预览）→ 嵌入 → 写入 outputPath。
 *
 * 运行时前置条件（均为“现场资源”，不打包进软件）：
 *   - 转换需本机 Chromium（mmd2vsdx 的 playwright 依赖）；
 *   - useConnectorMaster=true（默认）时需本机 Visio（自动搜寻模具，本地 Stencil 缓存）；
 *   - useConnectorMaster=false 为纯本地零资产模式（无 Visio 也可转换）；
 *   - **本工程不再生成预览**（旧版 Visio COM/EMF 渲染已移除）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { stripCaptionNumber } from '@documentor/core'
import type { DocumentTree } from '@documentor/core'
import type { StyleTemplateDef } from '@documentor/templates'
import { embedVsdxIntoDocx } from '@documentor/postprocess'
import type { FigureInput } from '@documentor/postprocess'
import { collectMermaidFigures, serializeWithWarnings } from './serializer'
import { writeDocx } from './writer'
import type { WriteInstruction } from './instructions'

/** 转换结果（上游 ConvertResult 的消费子集；preview 为可选附带物） */
export interface FigureConvertResult {
  ok: boolean
  vsdxBase64?: string
  error?: string
  /** 预览图 base64（建议上游字段；无预览/不支持的回退为无预览嵌入） */
  previewBase64?: string
  /** 预览格式（缺省 png）；emf 亦可（Word 原生支持） */
  previewExt?: 'png' | 'emf'
}

export interface FigurePipelineOptions {
  /** mmd2vsdx 母版模式（默认 true：Connector 母版；false=零资产纯本地几何） */
  useConnectorMaster?: boolean
  /** 测试注入：转换函数（缺省动态加载 mmd2vsdx） */
  convert?: (code: string, caption: string) => Promise<FigureConvertResult>
  /** 测试注入：mmd2vsdx 加载器（缺省动态 import('mmd2vsdx')；注入可模拟“模块不可用”降级） */
  loadConverter?: () => Promise<MmdConverter>
  /** 转换后从暂存区查找同名预览文件作为回退（默认 true；支持“上游另存 xxx.png/emf”的外部流程） */
  previewFromStaging?: boolean
  /** 暂存目录（缺省 = 系统临时目录/uuid；测试与外部预览文件回退可注入） */
  stagingDir?: string
  /** 覆盖 figure.caption 样式 ID（缺省取 styleDef.styleMap['figure.caption']） */
  captionStyleId?: string
  /** 最终输出路径（缺省 = <docxPath 去 .docx>-嵌入.docx；调用方显式给 = 交付即所给路径） */
  outputPath?: string
}

export interface FigurePipelineStats {
  /** 文档中 Mermaid 图块总数 */
  total: number
  /** 成功转成 vsdx 的数量 */
  converted: number
  /** 嵌入 docx 的对象数 */
  embedded: number
  /** 预览图（PNG/EMF）生成数（来自转换附带物/暂存区；无则为 0） */
  previewCount: number
  /** 失败明细（题注 + 原因） */
  failed: Array<{ caption: string; reason: string }>
}

export interface FigurePipelineResult {
  /** 实际输出路径（无图块时=输入路径） */
  outputPath: string
  figureStats: FigurePipelineStats
  warnings: string[]
}

interface Slot {
  name: string
  vsdx?: Uint8Array
  preview?: Uint8Array
  previewExt?: 'emf' | 'png' | 'jpg' | 'jpeg'
}

/**
 * 把已生成（占位式）的 docx 升级为 Visio OLE 嵌入版。
 * @param docxPath exportTreeToDocx 产出的占位式 docx（含 [Mermaid 图表: …] 段）
 */
export async function attachFiguresToDocx(
  docxPath: string,
  tree: DocumentTree,
  styleDef: StyleTemplateDef,
  options: FigurePipelineOptions
): Promise<FigurePipelineResult> {
  const warnings: string[] = []
  const figures = collectMermaidFigures(tree)
  const stats: FigurePipelineStats = {
    total: figures.length,
    converted: 0,
    embedded: 0,
    previewCount: 0,
    failed: []
  }
  if (figures.length === 0) {
    // 无图块不是"警告"：导出对话框已提示"当前文档没有图表"，此处再报会让成功提示变色。
    // 显式 outputPath 时：无图也把文档交付到用户路径
    const finalPath =
      options.outputPath && options.outputPath !== docxPath ? options.outputPath : docxPath
    if (finalPath !== docxPath) copyFileSync(docxPath, finalPath)
    return { outputPath: finalPath, figureStats: stats, warnings }
  }

  let loaded: MmdConverter | null = null
  if (!options.convert) {
    try {
      loaded = options.loadConverter
        ? await options.loadConverter()
        : await loadMmd2vsdxConverter(options.useConnectorMaster ?? true)
    } catch (err) {
      // 单一路径降级：图表嵌入服务不可用 → 交付文本版（不中断导出）
      warnings.push('图表嵌入服务不可用，图表以文本形式导出')
      const finalPath =
        options.outputPath && options.outputPath !== docxPath ? options.outputPath : docxPath
      if (finalPath !== docxPath) copyFileSync(docxPath, finalPath)
      return { outputPath: finalPath, figureStats: stats, warnings }
    }
  }
  const convertFn = options.convert ?? loaded!.convert

  const staging = options.stagingDir ?? join(tmpdir(), `documentor-mmd-${randomUUID()}`)
  mkdirSync(staging, { recursive: true })
  const slots: Slot[] = []
  try {
    for (let i = 0; i < figures.length; i++) {
      const fig = figures[i]!
      // 命名为“去号后的题注”，与 docx 中文占位段的下方题注一致（避免名称误报）
      const base = stripCaptionNumber(fig.caption) || fig.caption || `图${i + 1}`
      const name = `sdd-${String(i + 1).padStart(3, '0')}-${sanitizeCaption(base)}.vsdx`
      try {
        const r = await convertFn(fig.code, fig.caption)
        if (!r.ok || !r.vsdxBase64) {
          stats.failed.push({ caption: fig.caption || `图${i + 1}`, reason: r.error || '转换失败' })
          slots.push({ name })
          continue
        }
        const bytes = Uint8Array.from(Buffer.from(r.vsdxBase64, 'base64'))
        writeFileSync(join(staging, name), bytes)
        stats.converted++
        const slot: Slot = { name, vsdx: bytes }

        // 预览：① 转换返回附带物（上游同源预览，首选）
        if (r.previewBase64 && r.previewBase64.length > 0) {
          const ext = r.previewExt ?? 'png'
          slot.preview = Uint8Array.from(Buffer.from(r.previewBase64, 'base64'))
          slot.previewExt = ext
          stats.previewCount++
        } else if (options.previewFromStaging !== false) {
          // ② 暂存区同名预览文件回退（上游另存 <stem>.png/.emf 的外部流程）
          const pngPath = join(staging, name.replace(/\.vsdx$/i, '.png'))
          const emfPath = join(staging, name.replace(/\.vsdx$/i, '.emf'))
          const found = existsSync(pngPath)
            ? { path: pngPath, ext: 'png' as const }
            : existsSync(emfPath)
              ? { path: emfPath, ext: 'emf' as const }
              : null
          if (found) {
            slot.preview = readFileSync(found.path)
            slot.previewExt = found.ext
            stats.previewCount++
          }
        }
        slots.push(slot)
      } catch (err) {
        stats.failed.push({
          caption: fig.caption || `图${i + 1}`,
          reason: err instanceof Error ? err.message : String(err)
        })
        slots.push({ name })
      }
    }

    // 嵌入（槽位 k ↔ 文档占位段 k；转换失败槽位保留占位文本）
    const docxBytes = readFileSync(docxPath)
    const figuresForEmbed: FigureInput[] = slots.map((s) => ({
      name: s.name,
      vsdx: s.vsdx,
      preview: s.preview,
      previewExt: s.previewExt
    }))
    const embedResult = await embedVsdxIntoDocx(docxBytes, figuresForEmbed, {
      captionStyleId: options.captionStyleId ?? styleDef.styleMap['figure.caption'] ?? undefined
    })
    stats.embedded = embedResult.embeddedCount
    warnings.push(...embedResult.warnings)
    warnings.push(
      ...embedResult.nameMisses.map((m) => `「${m}」题注与文件不一致，已按顺序嵌入`)
    )
    if (stats.failed.length > 0) {
      warnings.push(
        `${stats.failed.length} 张图未能嵌入，已按文本导出：` +
        stats.failed.map((f) => `「${f.caption}」`).join('、')
      )
    }

    const outPath =
      options.outputPath ?? (docxPath.replace(/\.docx$/i, '') + '-嵌入.docx')
    writeFileSync(outPath, embedResult.docxBytes)
    if (outPath !== docxPath) rmSync(docxPath, { force: true })
    return { outputPath: outPath, figureStats: stats, warnings }
  } finally {
    rmSync(staging, { recursive: true, force: true })
    // 释放 mmd2vsdx 渲染资源（playwright 浏览器），避免进程存活卡住 CLI/退出
    if (loaded) {
      try {
        // 超时外壳：上游 shutdown 偶发挂起时不阻塞导出流程/进程退出
        await Promise.race([
          loaded.shutdown(),
          new Promise((resolve) => setTimeout(resolve, 5000))
        ])
      } catch { /* 释放失败不阻断 */ }
    }
  }
}

// ================= 一键导出（占位→嵌入，交付即所给路径） =================

export interface TreeDocxWithFiguresResult {
  outputPath: string
  clonedGroups: number
  instructions: WriteInstruction[]
  warnings: string[]
  figureStats: FigurePipelineStats
}

/**
 * 一步导出：序列化 → 写占位 docx（临时）→ 嵌入 VSDX/OLE → 写入 outputPath。
 * 交付语义：最终产物永远是 outputPath（无图块时占位版也写到 outputPath），
 * 避免“导出在 A、嵌入在 B”导致的错位困惑。
 */
export async function exportTreeToDocxWithFigures(
  tree: DocumentTree,
  styleDef: StyleTemplateDef,
  outputPath: string,
  options: FigurePipelineOptions
): Promise<TreeDocxWithFiguresResult> {
  const plainPath = outputPath.replace(/\.docx$/i, '') + '-占位.tmp.docx'
  try {
    const { instructions, warnings } = serializeWithWarnings(tree, styleDef)
    const base = await writeDocx(instructions, styleDef, plainPath)
    const fig = await attachFiguresToDocx(plainPath, tree, styleDef, {
      ...options,
      outputPath
    })
    return {
      outputPath: fig.outputPath,
      clonedGroups: base.clonedGroups,
      instructions,
      warnings: [...warnings, ...fig.warnings],
      figureStats: fig.figureStats
    }
  } finally {
    rmSync(plainPath, { force: true })
  }
}

// ================= 内部 =================

interface MmdConverter {
  convert: (code: string, caption: string) => Promise<FigureConvertResult>
  shutdown: () => Promise<void>
}

/**
 * 上游门面契约（PLAN-05 P0-1 / docs/UPSTREAM-mmd2vsdx.md §3.1）。
 * 新形态：包根导出 `convertText` / `shutdown`；旧形态：`application` 对象承载同名方法。
 */
export interface MmdFacade {
  convertText: (text: string, opts?: Record<string, unknown>) => Promise<FigureConvertResult>
  shutdown?: () => Promise<void>
}

function pickFacade(source: unknown): MmdFacade | null {
  if (!source || typeof source !== 'object') return null
  const s = source as Record<string, unknown>
  if (typeof s['convertText'] === 'function') {
    // bind：保留 this（上游方法可能依赖实例状态）
    return {
      convertText: (s['convertText'] as (...a: unknown[]) => unknown).bind(s) as MmdFacade['convertText'],
      shutdown:
        typeof s['shutdown'] === 'function'
          ? ((s['shutdown'] as (...a: unknown[]) => unknown).bind(s) as () => Promise<void>)
          : undefined
    }
  }
  const app = s['application']
  if (app && typeof app === 'object') {
    const a = app as Record<string, unknown>
    if (typeof a['convertText'] === 'function') {
      return {
        convertText: (a['convertText'] as (...x: unknown[]) => unknown).bind(app) as MmdFacade['convertText'],
        shutdown:
          typeof a['shutdown'] === 'function'
            ? ((a['shutdown'] as (...x: unknown[]) => unknown).bind(app) as () => Promise<void>)
            : undefined
      }
    }
  }
  return null
}

/**
 * 从上游模块命名空间解析门面，兼容三种形态：
 *   1) 新门面：模块根导出 `convertText` / `shutdown`
 *   2) 旧形态：`application` 对象承载同名方法
 *   3) CJS/ESM 互操作：`default` 包裹以上任一形态
 * 均不匹配 → 抛可读错误（含期望契约与文档指针），由调用方降级为文本占位。
 */
export function resolveMmdFacade(mod: unknown): MmdFacade {
  const direct = pickFacade(mod)
  if (direct) return direct
  if (mod && typeof mod === 'object') {
    const wrapped = pickFacade((mod as Record<string, unknown>)['default'])
    if (wrapped) return wrapped
  }
  const keys =
    mod && typeof mod === 'object' ? Object.keys(mod as object).join(', ') : `typeof ${typeof mod}`
  throw new Error(
    '上游未提供可用门面（期望 convertText/shutdown，或 application 对象承载）' +
      `；当前导出：${keys || '（无）'}。见 docs/UPSTREAM-mmd2vsdx.md`
  )
}

async function loadMmd2vsdxConverter(
  useConnectorMaster: boolean
): Promise<MmdConverter> {
  let facade: MmdFacade
  try {
    const mod = await import('mmd2vsdx')
    facade = resolveMmdFacade(mod)
  } catch (err) {
    throw new Error(
      `mmd2vsdx 模块不可用（请确认已安装 @documentor/desktop 的 link: 依赖）：` +
      (err instanceof Error ? err.message : String(err))
    )
  }
  return {
    convert: async (code) => {
      const r = await facade.convertText(code, {
        diagramType: 'auto',
        useConnectorMaster
      })
      // 预览为上游可选附带物：建议字段 previewBase64 + previewExt('png'|'emf')；
      // 上游未提供（undefined）→ 回退无预览嵌入，不报错。
      const anyR = r as unknown as {
        previewBase64?: string
        previewExt?: string
        previewPngBase64?: string
      }
      const previewBase64 = anyR.previewBase64 ?? anyR.previewPngBase64
      const previewExt = (anyR.previewExt ?? 'png') === 'emf' ? 'emf' : 'png'
      return {
        ok: r.ok,
        vsdxBase64: r.ok ? r.vsdxBase64 : undefined,
        error: r.error,
        previewBase64: previewBase64 && previewBase64.length > 0 ? previewBase64 : undefined,
        previewExt: previewBase64 && previewBase64.length > 0 ? previewExt : undefined
      }
    },
    shutdown: async () => {
      if (facade.shutdown) await facade.shutdown()
    }
  }
}

function sanitizeCaption(caption: string): string {
  const cleaned = caption
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned || '图'
}
