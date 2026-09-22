/**
 * 样式侧的人话换算（DESIGN-03）：把 stylemap 的校验结论翻成"哪一处"，
 * 以及对照表里那一行状态的说法。
 *
 * 为什么单独一个模块：结构那一侧的同名活儿在 `templateDoc.ts`（按节点路径拼面包屑），
 * 而样式侧的 path 是字段名（`styleMap['heading.1']`、`skeleton/word/styles.xml`、
 * `structure[甲结构].styleMap`），树里没有对应的东西可跳，只能给一个人读的标签。
 * 判定与文案仍以主进程的 `validateStyleTemplate` 为准，这里只负责显示。
 */
import type { TemplateIssueDto } from '../../../../shared/project'
import type { IssueGroup } from './templateDoc'

/** 对照表那一行的状态（与主进程 `StyleMapRowDto.status` 同值） */
export type StyleRowStatus = 'ok' | 'dangling' | 'inert' | 'unset' | 'unchecked'

/** 状态的短话（状态列的头一句；"为什么"由主进程给的 message 说） */
export function styleStatusLabel(status: StyleRowStatus): string {
  switch (status) {
    case 'ok':
      return '正常'
    case 'dangling':
      return '样式文件无此样式'
    case 'inert':
      return '配置不生效'
    case 'unchecked':
      return '未核对'
    default:
      return '未配'
  }
}

/** 状态的红/黄/中性：错的两档红、没核对黄、其余中性 */
export function styleStatusTone(status: StyleRowStatus): 'error' | 'warn' | 'plain' {
  if (status === 'dangling') return 'error'
  if (status === 'unchecked') return 'warn'
  return 'plain'
}

/**
 * 骨架里一条样式的悬停说明：只说下拉框上看不到的那几项（类型、字号、带不带自动编号）。
 * 名字与 styleId 就摆在选项里（选完还在下拉右边又写一遍），不再念第三遍。
 */
export function skeletonStyleTip(style: {
  type: string
  fontSizePt?: number
  numbered?: boolean
}): string {
  const parts = [style.type === '' ? '未写类型' : style.type]
  if (style.fontSizePt !== undefined) parts.push(`${style.fontSizePt} 磅`)
  if (style.numbered === true) parts.push('自带多级列表编号')
  return parts.join(' · ')
}

/**
 * 校验结论的 path → 人读的位置（映射 heading.1 / 骨架 word/styles.xml / 题注编号 表题 …）。
 * 认不出的原样返回：显示一个字段名也比显示"未知位置"强。
 */
export function issueWhereForStyle(path: string): string {
  const mapKey = /^styleMap\['(.+)'\]$/u.exec(path) ?? /^styleMap\.(.+)$/u.exec(path)
  if (mapKey) return `映射 ${mapKey[1]}`
  if (path === 'styleMap') return '映射表'
  if (path === 'cn') return '中文名'
  if (path === 'en') return '英文名'
  if (path === 'docxFolder') return '骨架目录名'
  if (path.startsWith('skeleton/')) return `骨架 ${path.slice('skeleton/'.length)}`
  if (path === 'skeleton') return '骨架'
  const caption = /^captionNumbering\.(.+)$/u.exec(path)
  if (caption) {
    const kind = caption[1] ?? ''
    const label =
      kind === 'table'
        ? '表题'
        : kind === 'figure'
          ? '图题'
          : kind === 'chapterStyleNames'
            ? '章节样式名'
            : kind
    return `题注编号 ${label}`
  }
  if (path === 'captionNumbering') return '题注编号'
  return path
}

/**
 * 样式侧结论按"哪一处"归堆，形状与结构侧那份索引一致（页脚同一个组件渲染）。
 *
 * 与结构侧的一处不同：这里**每一组都带原话**。结构侧的原话由节点面板逐条说，
 * 索引里只报位置与条数；样式侧没有那样的落点（对照表行说的是"这一行配得对不对"，
 * 与校验结论不是一件事），原话只在这里出现一次，不重复也不丢失。
 */
export function groupStyleIssues(issues: readonly TemplateIssueDto[]): IssueGroup[] {
  const out: IssueGroup[] = []
  const byKey = new Map<string, IssueGroup>()
  for (const issue of issues) {
    const where = issueWhereForStyle(issue.path)
    let group = byKey.get(where)
    if (!group) {
      group = { where, path: null, errors: 0, warnings: 0, messages: [] }
      byKey.set(where, group)
      out.push(group)
    }
    if (issue.level === 'error') group.errors += 1
    else group.warnings += 1
    group.messages.push(issue.message)
  }
  return out
}
