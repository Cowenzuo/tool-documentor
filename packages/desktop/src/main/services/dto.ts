/**
 * DocumentNode → NodeDto（纯结构，renderer 以 DTO 为状态镜像）。
 */
import type { DocumentNode } from '@documentor/core/tree'
import type { NodeDto } from '../../shared/project'

export function toNodeDto(node: DocumentNode): NodeDto {
  return {
    id: node.id,
    headingLevel: node.headingLevel,
    title: node.title,
    description: node.description,
    copyable: node.copyable,
    deletable: node.deletable,
    allowContentBlocks: node.allowContentBlocks,
    allowLayoutEdit: node.allowLayoutEdit,
    isSubTitle: node.isSubTitle,
    subTitleStyle: node.subTitleStyle,
    subTitleAutoNumber: node.subTitleAutoNumber,
    copyGroupId: node.copyGroupId,
    allowedChildLevels: [...node.allowedChildLevels],
    contentBlocks: node.contentBlocks.map((b) => structuredClone(b)),
    children: node.children.map((c) => toNodeDto(c))
  }
}
