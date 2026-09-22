/**
 * style-rules.ts — 样式模板（stylemap）校验规则：**只有判定与文案，不碰文件系统**。
 *
 * 为什么单独一个模块：编辑模式要在渲染层**实时**跑同一套规则（改了映射当场标红、
 * 有 error 不许保存），而 `validate.ts` 顶层 import 了 `node:fs`（读骨架用），
 * 渲染层打进浏览器包时会当场炸掉。所以把"需要读盘"的部分留在 `validate.ts`
 * （`validateStyleTemplate` 读盘后把骨架事实传进来），规则本身在这里，
 * **编辑模式与加载报告用的仍然是这一份实现**（PLAN-11 第 8 节第 7 条：校验一份实现）。
 *
 * 两条口径（PLAN-12）：
 *   - 完整性按软件支持的**全集**查缺键（`SUPPORTED_STYLE_KEYS`，18 个），与结构模板无关；
 *   - 不再有"结构所需逻辑键没覆盖"这类结论：样式齐了就任何结构都能配它导出。
 * 指针指向骨架里不存在的 styleId 仍报错——那是配错了，与结构无关。
 */
import { isTemplateUuid } from './identity'
import { SUPPORTED_STYLE_KEYS } from './style-keys'
import type { SkeletonStyleInfo, ValidationIssue } from './validate'

/** 骨架的事实：读盘那一步算好传进来，规则本身不碰 fs */
export interface SkeletonFacts {
  /** 骨架文件夹名（stylemap 的 docxFolder），消息里要用 */
  folder: string
  /** 骨架目录在不在 */
  exists: boolean
  /** 缺哪些必需部件（顺序与 SKELETON_REQUIRED_PARTS 一致） */
  missingParts: string[]
  /** `word/styles.xml` 里字面扫到的 styleId */
  styleIds: string[]
  /** 可读样式表（题注"号从哪来"要看它） */
  styles: SkeletonStyleInfo[]
  /** 各级标题起始编号；读不到就是 undefined */
  headingStarts?: number[]
}

export interface StyleRulesOptions {
  /** 给了才做需要骨架的检查（"缺部件 / styleId 在不在 / 起始编号"那几条） */
  skeleton?: SkeletonFacts
}

/** 题注编号合法的三个取值 */
const CAPTION_MODES = ['auto', 'static', 'field'] as const

/** 把任意 JSON 值按 JS 插值语义转成文案（与模板字符串一致：undefined → "undefined"） */
function text(value: unknown): string {
  return String(value)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 拼路径标签，统一用 `/`（Windows 上也照样显示得清楚） */
function label(...parts: string[]): string {
  return parts.join('/')
}

/**
 * 校验一份 stylemap。
 *
 * @param styleDef stylemap JSON 原文（`{ uuid, cn, en, styleMap, docxFolder, captionNumbering }`）
 * @param opts `skeleton`（骨架事实；不给就跳过需要骨架的检查）
 */
export function validateStyleMap(
  styleDef: unknown,
  opts: StyleRulesOptions = {}
): ValidationIssue[] {
  const out: ValidationIssue[] = []
  const doc = asObject(styleDef) ?? {}

  if (!isTemplateUuid(doc['uuid'])) {
    out.push({
      level: 'error',
      rule: 'style.uuid.invalid',
      path: 'uuid',
      message: `顶层uuid缺失或非法`
    })
  }
  const cn = doc['cn']
  if (typeof cn !== 'string' || cn.trim() === '') {
    out.push({
      level: 'error',
      rule: 'style.cn.missing',
      path: 'cn',
      message: `顶层cn缺失`
    })
  }
  const styleMap = asObject(doc['styleMap'])
  if (!styleMap) {
    out.push({
      level: 'error',
      rule: 'style.styleMap.missing',
      path: 'styleMap',
      message: `顶层styleMap缺失`
    })
    return out
  }

  // 样式模板一律完整：按软件支持的全集查缺键，缺一个就是 error（运行时缺键按正文输出）
  const missingKeys = SUPPORTED_STYLE_KEYS.filter((key) => !(key in styleMap))
  if (missingKeys.length > 0) {
    out.push({
      level: 'error',
      rule: 'style.key.missing',
      path: 'styleMap',
      message: `缺逻辑键：${missingKeys.join(' / ')}`
    })
  }

  const docxFolder = doc['docxFolder']
  if (!docxFolder) {
    out.push({
      level: 'error',
      rule: 'style.docxFolder.missing',
      path: 'docxFolder',
      message: `docxFolder缺失`
    })
    return out
  }

  // 骨架：没给骨架事实就没有骨架可查（编辑模式早期只改映射表时会走这条）
  /** 骨架里的样式表：题注"号从哪来"要看它，所以在骨架块外也要留着 */
  let skeletonStyles: SkeletonStyleInfo[] = []
  const skeleton = opts.skeleton
  if (skeleton) {
    if (!skeleton.exists) {
      out.push({
        level: 'error',
        rule: 'style.skeleton.missing',
        path: label('skeleton', skeleton.folder),
        message: `样式目录不存在`
      })
      return out
    }
    for (const part of skeleton.missingParts) {
      out.push({
        level: 'error',
        rule: 'style.skeleton.part',
        path: label('skeleton', part),
        message: `必需部件缺失：${part}`
      })
    }

    skeletonStyles = skeleton.styles
    if (skeleton.styleIds.length === 0) {
      out.push({
        level: 'error',
        rule: 'style.skeleton.styleId.none',
        path: 'skeleton/word/styles.xml',
        message: `样式读取失败`
      })
    } else {
      const validIds = new Set(skeleton.styleIds)
      for (const [logical, styleId] of Object.entries(styleMap)) {
        if (!validIds.has(String(styleId))) {
          out.push({
            level: 'error',
            rule: 'style.styleMap.styleId.missing',
            path: `styleMap['${logical}']`,
            message:
              `${logical}=${text(JSON.stringify(styleId))} · ` +
              `样式不存在`
          })
        }
      }
    }

    const starts = skeleton.headingStarts
    if (!starts) {
      out.push({
        level: 'warn',
        rule: 'style.skeleton.headingStarts',
        path: 'skeleton/word/numbering.xml',
        message:
          `起始编号读取失败 · ` +
          `题注章节号从 1 起算`
      })
    }
    // 起始编号不是 1 是事实陈述（有意的模板设计），不产出结论
  }

  const cnNumbering = doc['captionNumbering']
  const cnObj = asObject(cnNumbering)
  if (cnObj) {
    for (const kind of ['table', 'figure'] as const) {
      const mode = cnObj[kind]
      if (mode !== undefined && !(CAPTION_MODES as readonly string[]).includes(text(mode))) {
        out.push({
          level: 'error',
          rule: 'style.captionNumbering.mode',
          path: `captionNumbering.${kind}`,
          message:
            `captionNumbering.${kind}=${text(JSON.stringify(mode))} · ` +
            `取值非法`
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
          message: `章节号不随标题自动更新 · 英文版 Word 取不到标题样式名`
        })
      }
    }
  }
  /**
   * 题注的号从哪来：auto 靠骨架题注样式的多级列表，field 靠题注域，static 靠题注文字自带。
   * 缺 captionNumbering 等于全都按 auto；auto 的号来自骨架样式，样式也没带编号才是真没号。
   * 只说结果（号不会出现），不说"你没配 captionNumbering"——那半句是废话。
   */
  const captionStyleId = (kind: 'table' | 'figure'): string =>
    text(styleMap[kind === 'table' ? 'table.caption' : 'figure.caption'] ?? '')
  const styleNumbered = (styleId: string): boolean =>
    styleId !== '' && skeletonStyles.some((s) => s.styleId === styleId && s.numbered === true)
  if (!cnObj && opts.skeleton) {
    const noSource = (['table', 'figure'] as const).filter((kind) => {
      const styleId = captionStyleId(kind)
      return styleId !== '' && !styleNumbered(styleId)
    })
    if (noSource.length > 0) {
      out.push({
        level: 'warn',
        rule: 'style.captionNumbering.absent',
        path: 'captionNumbering',
        message:
          `题注编号不会出现 · ` +
          `骨架样式 ${noSource.map((k) => text(JSON.stringify(captionStyleId(k)))).join(' / ')} ` +
          `无多级列表编号`
      })
    }
  }

  return out
}
