/**
 * 权限口径：同一个权限，模板作者侧与工程编辑侧、界面标签与拒绝语里必须是同一个词。
 *
 * 口径来源是 PLAN-13 第 1 节：节点级四个开关（复制／裁剪／编辑／排版），
 * 内容块级三档（自由编辑／类型限制编辑／只读），另加作废的旧档位 `type`。
 * 词表只写在这一处：模板编辑器（作者侧）与工程编辑器（用户侧）都从这里取，
 * 谁也别再自己写一份，否则两边又会各说各话。
 *
 * 两处用词的分工：
 *   - `name`：开关与档位的正式名字，作者侧的开关标签、用户侧的标题下标签都用它；
 *   - `tag`：卡片头上的短标记，位置只够两三个字；
 *   - `tip`：一句话说清这个权限意味着什么，两侧的悬停提示都用它。
 */
export interface PermissionTerm {
  /** 正式名字 */
  name: string
  /** 卡片头上的短标记；自由档没有标记 */
  tag: string | null
  /** 一句话说明 */
  tip: string
}

/** 节点级：模板作者给用户的四个开关，按 PLAN-13 第 1.1 节的顺序 */
export const NODE_PERMISSION = {
  copyable: { name: '复制', tip: '模板允许复制这一章及其子章节' },
  deletable: { name: '裁剪', tip: '模板允许裁掉这一章' },
  allowContentBlocks: { name: '编辑', tip: '模板允许编辑这一章的内容块' },
  // 排版还没传到工程侧（PLAN-13 第 6 节），用户侧暂时不显示这一枚；名字先在这里占好
  allowLayoutEdit: { name: '排版', tip: '模板允许改这一章的块集合、顺序与类型' }
} as const

/** 内容块级：三档加一个作废的旧档位 */
export const BLOCK_TIER: Record<'free' | 'keep' | 'readonly' | 'legacy', PermissionTerm> = {
  free: { name: '自由编辑', tag: null, tip: '内容、类型、增删都由用户定' },
  keep: { name: '类型限制编辑', tag: '类型限制', tip: '内容可改，类型不能换，也不能删' },
  readonly: { name: '只读', tag: '只读', tip: '内容与类型都由模板给定，也不能删' },
  legacy: { name: '旧档位', tag: '旧档位', tip: '类型固定但可删' }
}

/** 块上写的 lock 值 → 档位；不写就是自由编辑 */
export function blockTierOf(lock: string | undefined): PermissionTerm {
  if (lock === 'keep') return BLOCK_TIER.keep
  if (lock === 'readonly') return BLOCK_TIER.readonly
  if (lock === 'type') return BLOCK_TIER.legacy
  return BLOCK_TIER.free
}

/** 节点上那两个总闸（界面与写入侧都按它判） */
export interface NodePermissionInput {
  allowContentBlocks: boolean
  allowLayoutEdit: boolean
}

/**
 * 编辑 × 排版 取交之后，这一章的块能做什么（PLAN-13 第 1.3 节那张表）。
 *
 * 三条轴的分工：
 *   - 编辑关 → 内容块一律不动；
 *   - 排版关 → 集合、顺序、类型都不能动，只剩改各块的内容；
 *   - 块档位 → 在写入侧再叠一层：只读连内容也不能改，类型限制编辑能改内容、不能删也不能换形状。
 *     位置不归块档位管：那是排版的事。
 *
 * 界面与写入侧用的是同一个函数、同一批说法，所以置灰提示与拒绝语不会各说各话。
 */
export interface BlockPermissions {
  editContent: boolean
  reshape: boolean
  add: boolean
  remove: boolean
  move: boolean
  /** 拒绝语：说清是哪一条挡的 */
  whyEditContent: string
  whyAdd: string
  whyRemove: string
  whyMove: string
}

export function blockPermissions(node: NodePermissionInput): BlockPermissions {
  const editing = node.allowContentBlocks
  const layout = node.allowLayoutEdit
  // 拒绝语先说挡在最前面的那一条：编辑关着就说编辑，编辑开着还拦得住就是排版
  const which = (what: string): string =>
    editing ? `模板把这一章的排版关着，不能${what}` : `模板把这一章的编辑关着，不能${what}`
  return {
    editContent: editing,
    reshape: editing && layout,
    add: editing && layout,
    remove: editing && layout,
    move: editing && layout,
    whyEditContent: '模板把这一章的编辑关着，内容块不能改',
    whyAdd: which('加内容'),
    whyRemove: which('删内容'),
    whyMove: which('移动内容')
  }
}

/** 换类型与换表头被拒时的说法：先看排版，再看块档位 */
export function reshapeRefusal(lock: string | undefined, perms: BlockPermissions): string {
  if (!perms.reshape) return '模板把这一章的排版关着，类型与表头不能改'
  if (lock === 'readonly') return '模板规定该内容为只读，类型不能改'
  return '模板规定的类型不能改，内容可以照常编辑'
}

/** 块被拒时的说法：先讲模板的规定，再讲这件事做不了 */
export function lockRefusal(lock: string | undefined, what: 'remove' | 'move' | 'edit'): string {
  if (what === 'edit') return '模板规定该内容为只读，内容不能改'
  const head = lock === 'readonly' ? '模板规定该内容为只读' : '模板规定该内容必须存在'
  return what === 'remove' ? `${head}，不能删除` : `${head}，不能移动`
}

/** 子树这种形状就够用：文档树的节点与 NodeDto 都满足 */
interface BlockHost {
  contentBlocks: ReadonlyArray<{ lock?: string }>
  children: readonly BlockHost[]
}

/**
 * 这一棵子树里有没有模板规定必须存在的块（类型限制编辑与只读）。
 *
 * 裁掉一整章会把里面的块一起带走，所以「必须存在」的块连它所在的章节一起护住：
 * 两级取交，谁更严听谁的（PLAN-13 第 1 节）。用户自己复制出来的那一份不带锁
 * （见 `DocumentNode.deepClone`），所以复制出来的章节不受这条限制。
 */
export function hasPinnedBlock(node: BlockHost): boolean {
  for (const block of node.contentBlocks) {
    if (block.lock === 'keep' || block.lock === 'readonly') return true
  }
  return node.children.some((child) => hasPinnedBlock(child))
}

/** 整章不能裁时的说法，写入侧与界面同一句 */
export const PINNED_BLOCK_REFUSAL = '模板规定这一章里有必须存在的内容：不能裁剪'
