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
