/**
 * style-match.ts — 从骨架样式表生成对照表**草稿**（PLAN-11 批次 3 的"缺映射时先给草稿"）。
 *
 * 导入一份自备样式（.docx 或已解包的骨架目录）之后，作者不该从零开始填 22 行：
 * 按样式名做一次模糊匹配，能认出来的键先填上（`标题 1`、`heading1`、`正文`、`表头` 这类），
 * 剩下的留空待填。**只从骨架里真实存在的样式里挑**——认不出就不填，绝不编一个 styleId。
 *
 * 认得出的键名与 `style-keys.ts` 的逻辑键表同一套；匹配用的是**归一化**后的名字与 styleId：
 * 小写、去掉空格 / 下划线 / 连字符（`Heading 1`、`heading_1`、`heading1` 是同一个东西）。
 */
import type { SkeletonStyleInfo } from './validate'

export interface StyleMapDraft {
  /** 认出来的映射（只含认出来的键；认不出的键不进这张表） */
  styleMap: Record<string, string>
  /** 认出来、填上了的键 */
  filled: string[]
  /** 没认出来、留空待填的键（按逻辑键表的顺序） */
  empty: string[]
}

/** 归一化：小写、去掉空格/下划线/连字符/点，用于宽松比对 */
function norm(value: string): string {
  return value.toLowerCase().replace(/[\s_.\-（）()]/gu, '')
}

/** 一条候选样式的几种写法（名字 + styleId），都归一化过 */
function keysOfStyle(style: SkeletonStyleInfo): string[] {
  const out = [norm(style.name), norm(style.styleId)]
  return out.filter((value) => value !== '')
}

/**
 * 每个逻辑键的候选写法，**顺序即优先级**：越靠前越可信。
 *
 * 两个刻意的安排：
 *   - **具体的键排在前面**（`figure.caption` 在 `figure` 之前、`table.*` 与 `list.*` 也在基础键之前）——
 *     否则 `figure` 那句"名字里含 figure"会把 `figureCaption` 抢走，图片段落被套上题注样式；
 *   - 一条样式被认领之后，后面只能靠**完全相等**的名字再用它？不——真实模板里
 *     `subtitle.1` 与 `list.ordered.1` 常常就是同一条样式，所以这里只把"模糊命中过的那一条"
 *     从后续模糊匹配里排除（同一份 styles.xml 里同名 styleId 出现两次的情况也照此各认各的）。
 *   - 程序不读的四个高阶列表键（`list.*.2/3`）**不生成草稿**：填了不生效，列出来只会误导。
 */
const PATTERNS: ReadonlyArray<{ key: string; names: readonly string[]; exact?: boolean }> = [
  /**
   * 标题与列表子标题这两组**只认完全相等**：它们的名字都带层级数字，
   * 而「列表子标题1」的结尾正好是「标题1」——允许"含"的话，heading.1 会把它抢走。
   * 其余那些按用途起名的键（正文/表头/图题……）允许"含"，好认「示例 表头」这类带前缀的写法。
   */
  ...([1, 2, 3, 4, 5, 6, 7] as const).map((level) => ({
    key: `heading.${level}`,
    names: [`标题${level}`, `heading${level}`, `${level}级标题`, `标题${level}级`],
    exact: true
  })),
  ...([1, 2, 3] as const).map((depth) => ({
    key: `subtitle.${depth}`,
    names: [`列表子标题${depth}`, `子标题${depth}`, `subtitle${depth}`, `subtitle${depth}级`],
    exact: true
  })),
  {
    key: 'figure.caption',
    names: ['图题', '图片题注', '图注', 'figurecaption', 'captionfigure', '图题注', '题注图']
  },
  { key: 'table.caption', names: ['表题', '表格题注', '表注', 'tablecaption', 'captiontable'] },
  { key: 'table.header', names: ['表头', '表头行', 'tableheader', 'header'] },
  { key: 'table.body', names: ['表体', '表格内容', '表格正文', 'tablebody', 'tabletext'] },
  {
    key: 'list.ordered.1',
    names: ['有序列表', '编号列表', '数字列表', 'listnumber', 'listordered', 'orderedlist', '编号']
  },
  {
    key: 'list.unordered.1',
    names: [
      '无序列表',
      '项目符号列表',
      '项目符号',
      '符号列表',
      'listbullet',
      'listunordered',
      'unorderedlist'
    ]
  },
  { key: 'body', names: ['正文', 'body', 'normal', '默认', '文本'] },
  { key: 'figure', names: ['图片', '图形', '图', '图表', 'figure', 'image', 'picture'] }
]

/** 逻辑键在草稿里的顺序（与 style-keys 的显示顺序一致：标题、列表子标题、正文、图、表、列表） */
const DRAFT_KEY_ORDER = [
  ...([1, 2, 3, 4, 5, 6, 7] as const).map((level) => `heading.${level}`),
  ...([1, 2, 3] as const).map((depth) => `subtitle.${depth}`),
  'body',
  'figure',
  'figure.caption',
  'table.caption',
  'table.header',
  'table.body',
  'list.unordered.1',
  'list.ordered.1'
]

/**
 * 从骨架样式表生成草稿映射。
 * 匹配：先按 PATTERNS 的顺序，用"归一化后的名字或 styleId 含这个写法"找**还没被认领**的那一条；
 * 找不到就留空——认不出就不填，绝不编一个 styleId 出来。
 */
export function draftStyleMap(skeleton: { styles: readonly SkeletonStyleInfo[] }): StyleMapDraft {
  const styleMap: Record<string, string> = {}
  const styleList = skeleton.styles.map((style) => ({
    styleId: style.styleId,
    keys: keysOfStyle(style)
  }))
  /** 已经被认领过的条目（按数组下标：同一份 styles.xml 里同名 styleId 出现两次时各算各的） */
  const claimed = new Set<number>()

  for (const pattern of PATTERNS) {
    for (const wanted of pattern.names) {
      const wantedNorm = norm(wanted)
      const index = styleList.findIndex(
        (style, i) =>
          !claimed.has(i) &&
          style.keys.some((key) =>
            pattern.exact === true ? key === wantedNorm : key.includes(wantedNorm)
          )
      )
      if (index < 0) continue
      const hit = styleList[index]!
      styleMap[pattern.key] = hit.styleId
      claimed.add(index)
      break
    }
  }

  const filled = DRAFT_KEY_ORDER.filter((key) => key in styleMap)
  return {
    styleMap,
    filled,
    empty: DRAFT_KEY_ORDER.filter((key) => !(key in styleMap))
  }
}
