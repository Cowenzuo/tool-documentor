/**
 * figure-export.ts — M7 图嵌入链路编排（Mermaid → VSDX → OLE 嵌入 docx）。
 *
 * 分工（2026-09 修订，接入形态改为本机常驻 HTTP 服务）：
 *   - **本包不再知道 mmd2vsdx 存在**：不 import 上游包、不解析门面、不持有浏览器。
 *     转换函数由调用方注入（`options.convert`，主进程侧是 HTTP 客户端）；
 *     没注入就整篇按文本版交付，与"服务不可用"走同一条降级；
 *   - 分层上这是必须的：库不得依赖 desktop，而 HTTP 客户端与点火都在主进程；
 *   - **不落盘**：上游服务不读文件也不写文件，产物字节全程在内存里，
 *     本模块不再有暂存目录、不再写临时 .vsdx；
 *   - 本模块只管编排：按文档顺序收集图块 → 逐张转换 → 嵌入 → 写入 outputPath。
 *
 * 降级语义（两条，别混）：
 *   - **单张失败**（图本身语法错、超大）→ 记进 `failed`，照常嵌入其余图；
 *   - **整体不可用**（`unavailable`）→ 立刻停手、丢弃已转的部分、整篇交付文本版。
 *     半嵌半不嵌的文档比一篇一致文本更难解释，所以这里不做部分提交。
 *     此时 `failed` 为空，调用方只有靠 `unavailable` 才知道 total 张全都没嵌入。
 *
 * 预览图：**由嵌入层自产**（2026-09 修订，见 docs/WORD处理经验/07）。
 *   上游没提供预览时，`embedVsdxIntoDocx` 会自产一张"带示意文字"的 EMF —— 预览图是 Word 嵌入才需要的
 *   东西，且与对象框/画布强相关，所以它归嵌入层。若将来上游要提供预览，走 `FigureConvertResult.previewBase64`
 *   这条通道（EMF，嵌入层会校验并按自洽式校正声明尺寸）。
 */
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { normalizeMermaidSource } from '@documentor/core'
import type { DocumentTree } from '@documentor/core'
import type { StyleTemplateDef } from '@documentor/templates'
import { embedVsdxIntoDocx, previewDpiOutOfBand } from '@documentor/postprocess'
import type { FigureInput } from '@documentor/postprocess'
import { collectMermaidFigures, serializeWithWarnings } from './serializer'
import { writeDocx } from './writer'
import type { WriteInstruction } from './instructions'

/** 转换结果（注入的 convert 的返回形状） */
export interface FigureConvertResult {
  ok: boolean
  vsdxBase64?: string
  /**
   * 可选的预览件（EMF，base64）。不提供时嵌入层会自产一张带示意文字的件。
   * 来源不明的件会按"声明尺寸 = 画布 × 逻辑dpi ÷ 参考dpi"校正后才用；标了 `visio` 的件不改写
   * （Visio 自带自洽声明，改反而破坏"内容 = 声明"）。
   */
  previewBase64?: string
  /**
   * 预览件来源。`visio` = Visio 自己导出的真图：不改声明尺寸、不报 dpi 告警窗。
   * 不给就按"来源不明"处理（照旧走两道护栏）。
   */
  previewSource?: 'visio' | 'external'
  error?: string
  /**
   * 转换服务整体不可用（没在运行、契约版本不符、连接类失败…）。
   * 与"单张失败"不同：这时应当**停止后续转换**并按文本版交付，
   * 而不是一张张试到底。判定规则全在客户端，这里不认 HTTP 状态码。
   */
  unavailable?: boolean
}

/** 转换函数：mermaid 原文进，VSDX 字节出（base64 承载） */
export type FigureConvertFn = (code: string, caption: string) => Promise<FigureConvertResult>

export interface FigurePipelineOptions {
  /**
   * 转换函数。主进程注入 HTTP 客户端；**不注入 = 整体不可用**，整篇按文本版交付。
   * 单张失败返回 `{ ok:false }`；服务级不可用返回 `{ ok:false, unavailable:true }`。
   */
  convert?: FigureConvertFn
  /** 覆盖 figure.caption 样式 ID（缺省取 styleDef.styleMap['figure.caption']） */
  captionStyleId?: string
  /** 工程目录：用于把图片块的 imagePath 解析为绝对路径并嵌入（缺省则输出占位文本） */
  imageBaseDir?: string
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
  /** 失败明细（题注 + 原因） */
  failed: Array<{ caption: string; reason: string }>
  /**
   * 转换服务整体不可用（没注入转换函数、服务没在跑、契约版本不符、中途崩了）。
   * 与"逐张失败"不同：这时 `failed` 是空的，调用方靠这个字段才知道 total 张全都没嵌进去。
   */
  unavailable?: boolean
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
  /** 上游可选提供的预览件（EMF）；无则由嵌入层自产 */
  preview?: Uint8Array
  /** 预览件来源：visio = 不改声明尺寸、不报 dpi 告警窗 */
  previewSource?: 'visio' | 'external'
}

/** 整体不可用时的统一提示（文案口径见 产品文案口径.md 第 7 条：不说依赖名与安装指引） */
const UNAVAILABLE_WARNING = '图以文本形式导出，双击编辑不可用'

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
    failed: []
  }

  /** 交付文本版：把占位 docx 原样交到用户路径 */
  const deliverText = (): FigurePipelineResult => {
    const finalPath =
      options.outputPath && options.outputPath !== docxPath ? options.outputPath : docxPath
    if (finalPath !== docxPath) copyFileSync(docxPath, finalPath)
    return { outputPath: finalPath, figureStats: stats, warnings }
  }

  if (figures.length === 0) {
    // 无图块不是"警告"：导出对话框已提示"当前文档没有图表"，此处再报会让成功提示变色。
    return deliverText()
  }

  const convertFn = options.convert
  if (!convertFn) {
    stats.unavailable = true
    warnings.push(UNAVAILABLE_WARNING)
    return deliverText()
  }

  const slots: Slot[] = []
  for (let i = 0; i < figures.length; i++) {
    const fig = figures[i]!
    // 名称取题注原文，与文档里的题注文字一致（嵌入时按名称做一致性诊断，名称不再去号）
    const base = fig.caption.trim() || `图${i + 1}`
    const name = `sdd-${String(i + 1).padStart(3, '0')}-${sanitizeCaption(base)}.vsdx`
    try {
      // 与编辑器渲染共用同一份规整：上游转换器未必容忍 markdown 围栏与语言标签，
      // 而用户粘进来的源码常常带着它们（编辑器渲染那条路已经在规整）。
      const r = await convertFn(normalizeMermaidSource(fig.code), fig.caption)
      if (r.unavailable === true) {
        // 服务整体不可用：停手，整篇按文本版交付。已转成功的部分一并丢弃——
        // 半嵌半不嵌的文档比一篇一致的文本版更难解释。
        stats.unavailable = true
        stats.converted = 0
        stats.embedded = 0
        stats.failed.length = 0
        warnings.push(UNAVAILABLE_WARNING)
        return deliverText()
      }
      if (!r.ok || !r.vsdxBase64) {
        stats.failed.push({ caption: fig.caption || `图${i + 1}`, reason: r.error || '转换失败' })
        slots.push({ name })
        continue
      }
      const bytes = Uint8Array.from(Buffer.from(r.vsdxBase64, 'base64'))
      stats.converted++
      const preview = r.previewBase64
        ? Uint8Array.from(Buffer.from(r.previewBase64, 'base64'))
        : undefined
      slots.push({ name, vsdx: bytes, preview, previewSource: r.previewSource })
    } catch (err) {
      stats.failed.push({
        caption: fig.caption || `图${i + 1}`,
        reason: err instanceof Error ? err.message : String(err)
      })
      slots.push({ name })
    }
  }

  // 嵌入（槽位 k ↔ 文档占位段 k；转换失败槽位保留占位文本）。
  // 预览件照传：来源可信的（Visio 导出的真图）直接用，来源不明的由嵌入层过 dpi 护栏。
  const docxBytes = readFileSync(docxPath)
  const figuresForEmbed: FigureInput[] = slots.map((s) => ({
    name: s.name,
    vsdx: s.vsdx,
    preview: s.preview,
    previewExt: s.preview ? 'emf' : undefined,
    ...(s.previewSource ? { previewSource: s.previewSource } : {})
  }))
  const embedResult = await embedVsdxIntoDocx(docxBytes, figuresForEmbed, {
    captionStyleId: options.captionStyleId ?? styleDef.styleMap['figure.caption'] ?? undefined,
    figureStyleId: styleDef.styleMap['figure'] ?? undefined
  })
  stats.embedded = embedResult.embeddedCount
  warnings.push(...embedResult.warnings)
  warnings.push(
    ...embedResult.nameMisses.map((m) => `「${m}」题注与文件不一致，已按顺序嵌入`)
  )
  if (stats.failed.length > 0) {
    warnings.push(
      `${stats.failed.length} 张图以文本形式导出：` +
      stats.failed.map((f) => `「${f.caption}」`).join('、')
    )
  }

  const outPath = options.outputPath ?? docxPath.replace(/\.docx$/i, '') + '-嵌入.docx'
  writeFileSync(outPath, embedResult.docxBytes)
  if (outPath !== docxPath) rmSync(docxPath, { force: true })
  return { outputPath: outPath, figureStats: stats, warnings }
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
 * 交付语义：最终产物永远是 outputPath（无图块或降级时占位版也写到 outputPath），
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
    const { instructions, warnings } = serializeWithWarnings(tree, styleDef, {
      imageBaseDir: options.imageBaseDir
    })
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

function sanitizeCaption(caption: string): string {
  const cleaned = caption
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return cleaned || '图'
}
