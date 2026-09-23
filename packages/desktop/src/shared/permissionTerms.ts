/**
 * 权限口径：同一个权限，模板作者侧与工程编辑侧、界面标签与拒绝语里必须是同一个词。
 *
 * 口径来源是 DESIGN-06：节点级四个开关（复制／裁剪／编辑／排版），
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

/** 节点级：模板作者给用户的四个开关，按 DESIGN-06的顺序 */
export const NODE_PERMISSION = {
  copyable: { name: '复制', tip: '模板允许复制本章及其子章节' },
  deletable: { name: '裁剪', tip: '模板允许裁掉本章' },
  allowContentBlocks: { name: '编辑', tip: '模板允许编辑本章内容块' },
  allowLayoutEdit: { name: '排版', tip: '模板允许改本章块集合、顺序与类型' }
} as const

/** 内容块级：三档加一个作废的旧档位 */
export const BLOCK_TIER: Record<'free' | 'keep' | 'readonly' | 'legacy', PermissionTerm> = {
  free: { name: '自由编辑', tag: null, tip: '内容、类型、增删都由用户定' },
  keep: { name: '类型限制编辑', tag: '类型限制', tip: '内容可改，类型不能换，也不能删' },
  readonly: { name: '只读', tag: '只读', tip: '内容与类型都由模板给定，也不能删' },
  legacy: { name: '旧档位', tag: '旧档位', tip: '类型固定但可删' }
}

/**
 * 内容块上的动作词：卡片头上那个入口用它，菜单标题与提示同一份。
 * 权限词表管"能不能做"，这里管"这件事叫什么"，两处都只有这一个说法。
 */
export const BLOCK_ACTION = {
  changeType: { name: '换类型', tip: '换成其他类型；可带内容一并带过去' }
} as const

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
 * 编辑 × 排版 取交之后，这一章的块能做什么（DESIGN-06那张表）。
 *
 * 三条轴的分工：
 *   - 编辑关 → 内容一律不动；
 *   - 排版关 → 集合、顺序、类型都不能动，只剩改各块的内容；
 *   - 块档位 → 在写入侧再叠一层：只读连内容也不能改，类型限制编辑能改内容、不能删也不能换形状。
 *     位置不归块档位管：那是排版的事。
 *
 * 两级的边界：这一份只管块自己（改内容／换形状／删／移），章节级的复制与裁剪由节点开关决定，
 * 块档位不否决章节级动作 —— 作者要护住整章，把「裁剪」关掉就是（缺省就是关的）。
 *
 * 界面与写入侧用的是同一个函数、同一批说法，所以置灰提示与拒绝语不会各说各话。
 * 说法一律是被禁那件事的短语（`禁止编辑内容`、`禁止增加内容`…）：不写成句子、
 * 不描述开关状态、也不出现「内容块」这种内部说法（见 产品文案口径.md）。
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
  /** 换类型／改表头被总闸挡住时的说法（`reshapeRefusal` 的第一档） */
  whyShape: string
}

export function blockPermissions(node: NodePermissionInput): BlockPermissions {
  const editing = node.allowContentBlocks
  const layout = node.allowLayoutEdit
  /**
   * 被挡住的说明一律是**短语「禁止…」**，不写成句子。
   *
   * 说明挂在被禁的那个控件上（按钮的悬停、输入框的 title），上下文已经说明了
   * "这件事是什么、在哪里"，所以只差一个结论：这件事被禁了。
   * 不写"模板里哪个开关处于什么状态"——那是机制，用户看不见也改不了。
   */
  return {
    editContent: editing,
    reshape: editing && layout,
    add: editing && layout,
    remove: editing && layout,
    move: editing && layout,
    whyEditContent: '禁止编辑内容',
    whyAdd: '禁止增加内容',
    whyRemove: '禁止删除内容',
    whyMove: '禁止移动内容',
    whyShape: '禁止修改类型与表头'
  }
}

/** 换类型与换表头被拒时的说法：先看总闸，再看块档位 */
export function reshapeRefusal(lock: string | undefined, perms: BlockPermissions): string {
  if (!perms.reshape) return perms.whyShape
  if (lock === 'readonly') return '模板规定该内容为只读，类型不能改'
  return '模板规定类型不能改，内容可以照常编辑'
}

/**
 * 块被拒时的说法：先讲模板的规定，再讲这件事做不了。
 *
 * 只有两件事会被块档位挡住：改内容（只读档）与删块（`keep`／`readonly`）。
 * 位置没有这一档：移块只由节点的「排版」决定，拒绝语是 `whyMove`。
 */
export function lockRefusal(lock: string | undefined, what: 'remove' | 'edit'): string {
  if (what === 'edit') return '模板规定该内容为只读，内容不能改'
  const head = lock === 'readonly' ? '模板规定该内容为只读' : '模板规定该内容必须存在'
  return `${head}，不能删除`
}
