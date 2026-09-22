/**
 * style-keys.ts — 逻辑样式键的元数据与对照表行（PLAN-12：完整性按软件支持的全集算）。
 *
 * 一份 stylemap 的 `styleMap` 是「逻辑键 → 骨架 styleId」的字典：键是程序拼 DOCX 时查的
 * 名字（`heading.1`、`table.header`…），值必须能在骨架 `word/styles.xml` 里找到。
 * 对照表界面要逐行回答三件事——**这一行管什么、现在指向谁、没配的话程序会怎么办**；
 * 这三件事的事实来源都在这里，界面与主进程不许各写一份。
 *
 * `SUPPORTED_STYLE_KEYS` 是**软件支持的全部样式键**（表里 `read` 为真的那些，共 18 个）：
 * 样式模板必须把它们配齐，校验按这个固定全集查缺键，与任何结构模板无关。
 * 四个高阶列表键程序不读，不进全集，配了只提示不生效。
 *
 * 与 `validate.ts` 的分工：
 *   - `validateStyleMap` 判的是**结论**（全集缺键、styleId 不存在、配了不读的键），
 *     保存前的闸门用它；
 *   - 本模块给的是**逐行的解释**，供界面显示与作者做判断；两者看的是同一份 styleMap
 *     与同一个骨架索引，所以同一条事实在两边不会打架。
 *
 * 键与用途的对应关系来自序列化器 `packages/docx/src/serializer.ts`：那里查哪个键，
 * 这里就说哪个键管什么；改序列化口径时两处一起改。
 */
import type { SkeletonStyleInfo } from './validate'

/** 对照表里的一个分区（界面按它分组，顺序即显示顺序） */
export type StyleKeyGroup = '标题' | '列表子标题' | '正文' | '表格' | '图片' | '列表' | '其他'

/** 一个逻辑样式键的静态说明 */
export interface LogicalStyleKeyInfo {
  /** 逻辑键（写进 styleMap 的那个名字） */
  key: string
  group: StyleKeyGroup
  /** 用途：这一行管哪些内容的样式（直接展示） */
  usage: string
  /**
   * 程序读不读这个键。`false` = 配了也不生效：当前只有列表的第 2/3 档
   * （序列化器各层列表都查 `list.*.1`，与对照表那几行标的"不读取"是同一条事实）。
   */
  read: boolean
  /**
   * 没配时程序实际会用的**另一个逻辑键**；`null` = 不回退，按 Word 默认样式输出
   * （导出时另有一条"样式未生效"的告警）。
   */
  fallback: string | null
}

/** 认得的逻辑键全表（顺序即对照表的显示顺序） */
export const STYLE_KEY_INFO: readonly LogicalStyleKeyInfo[] = [
  ...([1, 2, 3, 4, 5, 6, 7] as const).map((level) => ({
    key: `heading.${level}`,
    group: '标题' as const,
    usage: `${level} 级标题的段落样式`,
    read: true,
    fallback: null
  })),
  ...([1, 2, 3] as const).map((depth) => ({
    key: `subtitle.${depth}`,
    group: '列表子标题' as const,
    usage: `列表子标题第 ${depth} 层的段落样式`,
    read: true,
    fallback: null
  })),
  {
    key: 'body',
    group: '正文',
    usage: '正文段落：文本块、公式块、代码块',
    read: true,
    fallback: null
  },
  {
    key: 'figure',
    group: '图片',
    usage: '图片与图形所在段落的样式',
    read: true,
    fallback: 'body'
  },
  {
    key: 'figure.caption',
    group: '图片',
    usage: '图片题注的段落样式',
    read: true,
    fallback: null
  },
  {
    key: 'table.caption',
    group: '表格',
    usage: '表格题注的段落样式',
    read: true,
    fallback: null
  },
  {
    key: 'table.header',
    group: '表格',
    usage: '表头行的段落样式',
    read: true,
    fallback: null
  },
  {
    key: 'table.body',
    group: '表格',
    usage: '表格内容行的段落样式',
    read: true,
    fallback: null
  },
  {
    key: 'list.unordered.1',
    group: '列表',
    usage: '无序列表的段落样式',
    read: true,
    fallback: null
  },
  {
    key: 'list.unordered.2',
    group: '列表',
    usage: '无序列表第 2 档 · 程序不读',
    read: false,
    fallback: null
  },
  {
    key: 'list.unordered.3',
    group: '列表',
    usage: '无序列表第 3 档 · 程序不读',
    read: false,
    fallback: null
  },
  {
    key: 'list.ordered.1',
    group: '列表',
    usage: '有序列表的段落样式',
    read: true,
    fallback: null
  },
  {
    key: 'list.ordered.2',
    group: '列表',
    usage: '有序列表第 2 档 · 程序不读',
    read: false,
    fallback: null
  },
  {
    key: 'list.ordered.3',
    group: '列表',
    usage: '有序列表第 3 档 · 程序不读',
    read: false,
    fallback: null
  }
]

/**
 * 软件支持的全部样式键：样式模板必须覆盖这些键，缺一个就是一个 error。
 * 从 `STYLE_KEY_INFO` 里取 `read` 为真的那些，顺序即对照表顺序。
 */
export const SUPPORTED_STYLE_KEYS: readonly string[] = STYLE_KEY_INFO.filter(
  (info) => info.read
).map((info) => info.key)

const INFO_BY_KEY = new Map(STYLE_KEY_INFO.map((info) => [info.key, info]))

/**
 * 取一个逻辑键的说明。文件里写了表外的键（例如手写时拼错的 `heading.10`）也能拿到说明：
 * 它落在「其他」分区，并明说程序不读——比在界面上把它藏起来好，藏起来作者就不知道
 * 自己配的那一行为什么不生效。
 */
export function styleKeyInfo(key: string): LogicalStyleKeyInfo {
  const known = INFO_BY_KEY.get(key)
  if (known) return known
  return {
    key,
    group: '其他',
    usage: '程序认不出这个逻辑键，配了不生效',
    read: false,
    fallback: null
  }
}

/** 对照表一行的状态 */
export type StyleMapRowStatus =
  /** 配了且指向的样式在骨架里 */
  | 'ok'
  /** 配了，但骨架 styles.xml 里没有这个 styleId */
  | 'dangling'
  /** 程序不读这个键，配了不生效 */
  | 'inert'
  /** 没配（用到时按默认样式或按回退键输出） */
  | 'unset'
  /** 骨架没读到（或一个 styleId 都没有），这一行没得核对 */
  | 'unchecked'

/** 对照表的一行：逻辑键的说明 + 现状 + 结论 */
export interface StyleMapRow {
  key: string
  group: StyleKeyGroup
  usage: string
  read: boolean
  fallback: string | null
  /** 当前指向的 styleId（没配是空串） */
  styleId: string
  status: StyleMapRowStatus
  /** 一句话结论（直接展示给作者） */
  message: string
}

export interface BuildStyleMapRowsInput {
  /** styleMap 原文（值按 String 处理；非字符串值会被照原样报出来） */
  styleMap: Record<string, unknown>
  /**
   * 骨架里的 styleId（判定 dangling 用）。**`null` = 骨架没读到**：
   * 这时配了值的行一律记 `unchecked`，不报"样式不存在"——那是"没核对"，
   * 不是"配错了"，缺骨架这件事由校验自己报（`style.skeleton.missing` 那几条）。
   * 认得的样式一个都读不到时也要传 `null`（一个 styleId 都没有的骨架没法当判据）。
   */
  skeletonStyleIds?: readonly string[] | null
  /**
   * 骨架里的可读样式表（拼"指向「表头」（th）"这句话用）。
   * 不给就只报 styleId，不影响判定。
   */
  skeletonStyles?: readonly SkeletonStyleInfo[]
}

/** 把 `styleMap` 里的值当字符串看：数组 / 对象这种明显的写错也照样显示出来 */
function rawText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  if (value === null) return 'null'
  return typeof value === 'object' ? (JSON.stringify(value) ?? '') : String(value)
}

/**
 * 生成对照表：**认得的逻辑键全都在**（哪怕文件里没写这一行），
 * 外加文件里多出来的键（落在「其他」分区）。这样"缺一个键"在界面上是一行红字，
 * 而不是一个需要作者自己发现的空缺。
 *
 * 顺序：先按 `STYLE_KEY_INFO` 的顺序走全部认得的键，再按文件里的顺序补表外的键。
 */
export function buildStyleMapRows(input: BuildStyleMapRowsInput): StyleMapRow[] {
  const styleIds =
    input.skeletonStyleIds === undefined || input.skeletonStyleIds === null
      ? null
      : new Set(input.skeletonStyleIds)
  const styleNameById = new Map<string, string>()
  for (const style of input.skeletonStyles ?? []) {
    if (style.name !== '') styleNameById.set(style.styleId, style.name)
  }

  const rows: StyleMapRow[] = []
  const seen = new Set<string>()
  const keys = [...STYLE_KEY_INFO.map((info) => info.key)]
  for (const key of Object.keys(input.styleMap)) {
    if (!seen.has(key) && !INFO_BY_KEY.has(key)) keys.push(key)
  }
  for (const key of keys) {
    if (seen.has(key)) continue
    seen.add(key)
    const info = styleKeyInfo(key)
    const styleId = rawText(input.styleMap[key])
    const name = styleNameById.get(styleId)
    const target = styleId === '' ? '' : name ? `「${name}」（${styleId}）` : `样式 ${styleId}`
    rows.push({
      key,
      group: info.group,
      usage: info.usage,
      read: info.read,
      fallback: info.fallback,
      styleId,
      ...statusOf({ info, styleId, target, styleIds })
    })
  }
  return rows
}

/** 一行的状态与那句话（判定顺序：不读 → 没配 → 没得核对 → 指向不存在 → 正常） */
function statusOf(args: {
  info: LogicalStyleKeyInfo
  styleId: string
  target: string
  styleIds: ReadonlySet<string> | null
}): { status: StyleMapRowStatus; message: string } {
  const { info, styleId, target, styleIds } = args
  if (styleId !== '' && !info.read) {
    return {
      status: 'inert',
      message: `不读取`
    }
  }
  if (styleId === '') {
    if (!info.read) {
      return {
        status: 'unset',
        message: '未配 · 不读取'
      }
    }
    return {
      status: 'unset',
      message:
        info.fallback === null
          ? '没配：用到时按 Word 默认样式输出'
          : `没配：程序回退用 ${info.fallback}`
    }
  }
  if (styleIds === null) {
    return {
      status: 'unchecked',
      message: `未核对`
    }
  }
  if (!styleIds.has(styleId)) {
    return {
      status: 'dangling',
      message: `指向的样式 ${styleId} 在骨架 styles.xml 里不存在，导出时这些位置按默认样式输出`
    }
  }
  return {
    status: 'ok',
    message: `指向${target}`
  }
}

/**
 * 骨架里有、这份对照表没人用的 styleId。
 * 只排除 `styleMap` 的值（照字面比），不做"这个 styleId 是不是被别的样式 basedOn 了"的推断——
 * 那是 Word 自己的引用关系，程序管不着；这条只是"顺便看看有没有漏配"。
 */
export function unusedSkeletonStyleIds(
  styleMap: Record<string, unknown>,
  skeletonStyles: readonly SkeletonStyleInfo[]
): string[] {
  const used = new Set(Object.values(styleMap).map((value) => rawText(value)))
  return skeletonStyles.map((style) => style.styleId).filter((id) => !used.has(id))
}
