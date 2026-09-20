/* 生成合成样例工程（dproj + db），供存储兼容回归（无任何外部版权内容）
 * 用法：node --experimental-sqlite scripts/gen-sample-project.cjs
 * 注意：@documentor/* 从本包（packages/desktop）node_modules 链接解析。
 */
const { mkdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const core = require('@documentor/core')

const dir = join(__dirname, '..', '..', '..', 'samples', 'sample-project')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })

const instance = {
  root: {
    title: '示例工程文档',
    children: [
      {
        title: '范围',
        headingLevel: 1,
        children: [
          {
            title: '标识',
            headingLevel: 2,
            contentBlocks: [
              { type: 'orderedList', items: ['条目一：示例', '条目二：示例', '条目三：示例'] }
            ]
          },
          {
            title: '概述',
            headingLevel: 2,
            contentBlocks: [{ type: 'text', content: '示例正文段落。' }]
          }
        ]
      },
      {
        title: '引用文档',
        headingLevel: 1,
        contentBlocks: [
          {
            type: 'table',
            caption: '示例引用',
            rows: 1,
            cols: 3,
            headers: ['序号', '标识', '标题'],
            data: [['1', 'DEMO-001', '示例文档']]
          }
        ]
      },
      {
        title: '附录',
        headingLevel: 3,
        nodeType: 'subTitle',
        subTitleStyle: 'alpha',
        contentBlocks: [{ type: 'text', content: '附录正文。' }]
      }
    ]
  }
}

const tree = core.buildTreeFromInstance(instance)
const dbPath = join(dir, 'documentor.db')
const store = new core.ProjectStore()
store.create(dbPath, '示例工程', '示例文档模板 (Demo)')
store.save(tree)
store.close()

const now = core.localIsoNow()
core.writeAnchor(dir, {
  version: 1,
  name: '示例工程',
  template: '示例文档模板 (Demo)',
  db_file: 'documentor.db',
  created_at: now,
  updated_at: now
})

console.log('sample-project written:', dir)
