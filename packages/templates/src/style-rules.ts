/**
 * style-rules.ts — 样式模板（stylemap）校验规则：**只有判定与文案，不碰文件系统**。
 *
 * 为什么单独一个模块：编辑模式要在渲染层**实时**跑同一套规则（改了映射当场标红、
 * 有 error 不许保存），而 `validate.ts` 顶层 import 了 `node:fs`（读骨架用），
 * 渲染层打进浏览器包时会当场炸掉。所以把"需要读盘"的部分留在 `validate.ts`
 * （`validateStyleTemplate` 读盘后把骨架事实传进来），规则本身在这里，
 * **编辑模式与加载报告用的仍然是这一份实现**（PLAN-11 第 8 节第 7 条：校验一份实现）。
 *
 * 判定条件与文案与模板仓库 `dev-scripts/check-templates.cjs` 的 `checkStyle` 逐字一致，
 * 由 `localscripts/tests/templates/parallel-check.test.ts` 拿真实模板钉住；
 * 想改判定或文案时，脚本与本模块必须一起改。
 */
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
  /** 模板 id（脚本用 manifest 的 id）；缺省取 stylemap 的 name */
  id?: string
  /** manifest 里的 stylemap_file（含 .json），同时用来推导与结构模板配对的 key */
  stylemapFile?: string
  /** manifest 里的 style_folder，用于报"manifest 与 stylemap 的 docxFolder 不一致" */
  manifestStyleFolder?: string
  /** 给了才做需要骨架的检查（"缺部件 / styleId 在不在 / 起始编号"那几条） */
  skeleton?: SkeletonFacts
}

/** 程序不读的高阶列表键（脚本 checkStyle 里逐个点名的四个） */
const UNREAD_LIST_KEYS = [
  'list.ordered.2',
  'list.ordered.3',
  'list.unordered.2',
  'list.unordered.3'
] as const

/** 题注编号合法的三个取值（脚本 checkStyle 内联的数组） */
const CAPTION_MODES = ['auto', 'static', 'field'] as const

/** 把任意 JSON 值按 JS 插值语义转成文案（与脚本的模板字符串一致：undefined → "undefined"） */
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

/** 结构节点 → 递归收集它用到的逻辑样式键（与 validate.ts 的 collectStyleKeys 同法） */
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
  for (const raw of Array.isArray(obj['contentBlocks']) ? (obj['contentBlocks'] as unknown[]) : []) {
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
  const children = Array.isArray(obj['children'])
    ? (obj['children'] as unknown[])
    : Array.isArray(obj['defaultChildren'])
      ? (obj['defaultChildren'] as unknown[])
      : []
  for (const child of children) collectStyleKeys(child, isSub ? subDepth + 1 : 0, keys)
  return keys
}

/** 结构里的题注（表题 / 图题），用于核对与题注编号模式是否打架（脚本 collectCaptions 照抄） */
function collectCaptions(
  node: unknown,
  out: Array<{ kind: 'table' | 'figure'; text: string }> = []
): Array<{ kind: 'table' | 'figure'; text: string }> {
  const obj = asObject(node)
  if (!obj) return out
  for (const raw of Array.isArray(obj['contentBlocks']) ? (obj['contentBlocks'] as unknown[]) : []) {
    const b = asObject(raw)
    if (!b || !b['caption']) continue
    if (b['type'] === 'table') out.push({ kind: 'table', text: text(b['caption']) })
    else if (b['type'] === 'image' || b['type'] === 'mermaid') {
      out.push({ kind: 'figure', text: text(b['caption']) })
    }
  }
  const children = Array.isArray(obj['children'])
    ? (obj['children'] as unknown[])
    : Array.isArray(obj['defaultChildren'])
      ? (obj['defaultChildren'] as unknown[])
      : []
  for (const child of children) collectCaptions(child, out)
  return out
}

/**
 * 校验一份 stylemap（脚本 `checkStyle` 的照抄版）。
 *
 * @param styleDef stylemap JSON 原文（`{ name, styleMap, docxFolder, captionNumbering }`）
 * @param structureDefs 结构模板 JSON 原文列表，用于"结构需要的逻辑键有没有被覆盖"与题注口径比对；
 *   只比对 `styleTemplate`（或 `styleTemplates` 里）等于本 stylemap 文件键的那些结构
 * @param opts `id`、`stylemapFile`、`manifestStyleFolder`、`skeleton`（骨架事实；不给就跳过需要骨架的检查）
 */
export function validateStyleMap(
  styleDef: unknown,
  structureDefs: readonly unknown[] = [],
  opts: StyleRulesOptions = {}
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
        message: `styles/${id}/${skeleton.folder} 骨架目录不存在`
      })
      return out
    }
    for (const part of skeleton.missingParts) {
      out.push({
        level: 'error',
        rule: 'style.skeleton.part',
        path: label('skeleton', part),
        message: `styles/${id}/${skeleton.folder} 缺部件 ${part}`
      })
    }

    skeletonStyles = skeleton.styles
    if (skeleton.styleIds.length === 0) {
      out.push({
        level: 'error',
        rule: 'style.skeleton.styleId.none',
        path: 'skeleton/word/styles.xml',
        message: `styles/${id}/${skeleton.folder}/word/styles.xml 读不到任何 styleId`
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
              `styles/${id}：styleMap 的 ${logical}=${text(JSON.stringify(styleId))} ` +
              `在骨架 styles.xml 里不存在（该处会按默认样式输出）`
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
  }
  /**
   * 题注的号从哪来：auto 靠骨架题注样式的多级列表，field 靠题注域，static 靠题注文字自带。
   * 前两种情况下题注文字里再写「表N」就会出两个号——**程序不剥离手写前缀**
   * （PLAN-07：题注文字原样带出），所以这里只看"文字里到底有没有写号"，不再猜程序会不会剥。
   */
  const captionStyleId = (kind: 'table' | 'figure'): string =>
    text(styleMap[kind === 'table' ? 'table.caption' : 'figure.caption'] ?? '')
  const styleNumbered = (styleId: string): boolean =>
    styleId !== '' && skeletonStyles.some((s) => s.styleId === styleId && s.numbered === true)
  const captionMode = (kind: 'table' | 'figure'): string => text(cnObj?.[kind] ?? 'auto')
  if (!cnObj && opts.skeleton) {
    // 缺 captionNumbering = 全都按 auto；auto 的号来自骨架样式，样式也没带编号才是真没号。
    // （原来这条写的是"手写前缀会被剥掉"，剥离已经删掉，那句话不再成立。）
    // 没配 caption.caption 键的不在这里报：那是"结构所需逻辑键没被覆盖"那条 error 的事。
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
          `styles/${id}：没有 captionNumbering，` +
          `${noSource.map((k) => (k === 'table' ? '表题' : '图题')).join(' / ')}按 auto 处理，` +
          `但骨架样式 ${noSource.map((k) => text(JSON.stringify(captionStyleId(k)))).join(' / ')} ` +
          `没带多级列表编号——这样导出的题注不会有自动号（靠题注文字手写号的话可忽略本条）`
      })
    }
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
    // 题注手写号：号已经由样式（auto 且样式带编号）或题注域（field）给出时，
    // 题注文字里再写「表N」就会出两个号——程序不剥离手写前缀（PLAN-07 口径）。
    // static 不在范围内：那种模式下号本来就写在文字里。
    const captions = collectCaptions(root)
    for (let i = 0; i < captions.length; i++) {
      const cap = captions[i]!
      const mode = captionMode(cap.kind)
      if (mode === 'static') continue
      if (mode === 'auto' && !styleNumbered(captionStyleId(cap.kind))) continue
      // 「表」/「图」后面跟数字、空格、全角空格、【 或括号，才算自己写了号；
      // 「表面处理要求」这种只是碰巧以此开头的不算。
      if (/^(表|图)[\s\u3000\d【（(]/u.test(cap.text)) {
        const from = mode === 'auto' ? '样式多级列表' : '题注域'
        out.push({
          level: 'warn',
          rule: 'style.caption.handwritten',
          path: `structure[${stName}].captions[${i}]`,
          message:
            `样式 ${id}：结构「${stName}」的题注「${cap.text.slice(0, 28)}…」自己写了号，` +
            `而 ${mode} 模式下号由${from}给——程序不剥离手写前缀，导出会重复` +
            `（题注只写名称，号交给样式或题注域）`
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
