import { describe, expect, it } from 'vitest'
import { resetIdCounterForTest } from '../src/idgen'
import { buildTreeFromInstance } from '../src/instance'
import type { InstanceFile } from '../src/instance'

describe('实例 JSON → 文档树（对齐旧版 buildInstanceNode）', () => {
  it('节点/块全类型映射 + heading 视为文本块', () => {
    resetIdCounterForTest()
    const instance: InstanceFile = {
      name: '样例',
      basedOn: '438C-软件需求规格说明(SRS)',
      styleTemplate: '438c-srs-stylemap',
      root: {
        title: '软件需求规格说明',
        children: [
          {
            title: '范围',
            headingLevel: 1,
            children: [
              {
                title: '标识',
                headingLevel: 2,
                contentBlocks: [
                  { type: 'orderedList', items: ['软件名称：', '软件标识：'] },
                  { type: 'text', content: '一段正文' },
                  {
                    type: 'table',
                    caption: '表1 引用文档',
                    rows: 1,
                    cols: 2,
                    headers: ['序号', '标题'],
                    data: [['1', '文档']]
                  },
                  { type: 'mermaid', caption: '图1 结构', content: 'graph TD\nA-->B' },
                  { type: 'heading', content: '章节式文本' }
                ]
              }
            ]
          },
          {
            title: '附录 A',
            nodeType: 'subTitle',
            subTitleStyle: 'alpha',
            headingLevel: 3,
            contentBlocks: [{ type: 'unorderedList', items: ['x'] }]
          }
        ]
      }
    }
    const tree = buildTreeFromInstance(instance)
    const root = tree.root
    expect(root.isRoot()).toBe(true)
    expect(root.title).toBe('软件需求规格说明')

    const scope = root.children[0]!
    expect(scope.title).toBe('范围')
    expect(scope.headingLevel).toBe(1)
    const biaoShi = scope.children[0]!
    expect(biaoShi.contentBlocks).toHaveLength(5)
    expect(biaoShi.contentBlocks[0]).toEqual({
      type: 'orderedList',
      items: ['软件名称：', '软件标识：']
    })
    expect(biaoShi.contentBlocks[3]).toEqual({
      type: 'mermaid',
      caption: '图1 结构',
      code: 'graph TD\nA-->B'
    })
    expect(biaoShi.contentBlocks[4]).toEqual({ type: 'text', content: '章节式文本' })

    const sub = root.children[1]!
    expect(sub.isSubTitle).toBe(true)
    expect(sub.subTitleStyle).toBe('alpha')
  })

  it('实例树可完整导出指令（与 docx serializer 对接）', async () => {
    // 冒烟：与导出管线的类型对接由 docx 包测试覆盖，这里确保可遍历
    resetIdCounterForTest()
    const instance: InstanceFile = {
      root: { title: 'T', children: [{ title: '章', contentBlocks: [{ type: 'text', content: '正文' }] }] }
    }
    const tree = buildTreeFromInstance(instance)
    expect(tree.root.children[0]!.contentBlocks[0]).toEqual({ type: 'text', content: '正文' })
  })
})
