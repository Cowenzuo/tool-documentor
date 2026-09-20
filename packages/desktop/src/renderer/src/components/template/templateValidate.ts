/**
 * 即时校验（渲染层）：结构模板的节点树与内容块规则，判定条件与文案逐条对齐
 * `packages/templates/src/validate.ts` 的 `validateStructureTemplate`，
 * 让人改动后立刻看到结论，而不是等到保存被主进程打回。
 *
 * 为什么是镜像而不是直接 import 那个包：它在模块顶层 import 了 `node:fs`
 * （读骨架用），出口 index 还会带出 `manager.ts` → `@documentor/core`（库里带原生模块）。
 * 渲染层打进浏览器包时，node 内置模块会被替换成只有 default 的 shim，具名导入当场报错。
 * 所以这里只镜像**单份模板能判的规则**（文件级字段、节点开关、内容块字段、表格形状、
 * 锁取值、复制组），目录与 manifest 级别的规则仍只由主进程报。
 *
 * 保存仍以主进程的校验为准：这里只决定按钮亮不亮、以及问题列表长什么样。
 */
import type { TemplateIssueDto } from '../../../../shared/project'

export interface StructureValidateOptions {
  /** 模板 id（目录名）；缺省取结构 JSON 的 name */
  id?: string
  /** manifest 里登记的文件名；给了才拼得出 structures/<id>/<file> 这种文件级措辞 */
  file?: string
}

/** 认识的内容块类型（与 @documentor/core 的 BLOCK_TYPE_NAMES 同值同序） */
const KNOWN_BLOCK_TYPES = [
  'text',
  'image',
  'table',
  'formula',
  'code',
  'mermaid',
  'orderedList',
  'unorderedList'
] as const

/** 块锁三档；顺序参与文案，不要调整 */
const LOCK_TIERS = ['type', 'keep', 'readonly'] as const

/** 与模板校验同法：任意 JSON 值按 JS 插值语义转成文案（undefined → "undefined"） */
function text(value: unknown): string {
  return String(value)
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function whereOf(trail: string): string {
  return trail || '(root)'
}

/**
 * 校验一份结构模板 JSON 原文（`{ name, root }`）。
 * `path` 与主进程同一套写法：`root.children[2].contentBlocks[0].lock`。
 */
export function validateStructureDoc(
  def: unknown,
  opts: StructureValidateOptions = {}
): TemplateIssueDto[] {
  const out: TemplateIssueDto[] = []
  const doc = asObject(def) ?? {}
  const id = opts.id !== undefined && opts.id !== '' ? opts.id : text(doc['name'] ?? '') || '(未命名)'
  const fileLabel = opts.file
    ? `structures/${id}/${opts.file}`
    : `structures/${id}`

  if (!doc['name']) {
    out.push({
      level: 'error',
      rule: 'structure.name.missing',
      path: 'name',
      message: `${fileLabel} 缺顶层 name（缺了整份文件被丢弃）`
    })
  }
  const root = asObject(doc['root'])
  if (!root) {
    out.push({
      level: 'error',
      rule: 'structure.root.missing',
      path: 'root',
      message: `${fileLabel} 缺顶层 root（缺了整份文件被丢弃）`
    })
    return out
  }
  if (!doc['styleTemplate'] && !Array.isArray(doc['styleTemplates'])) {
    out.push({
      level: 'warn',
      rule: 'structure.styleTemplate.absent',
      path: 'styleTemplate',
      message: `structures/${id}：既没有 styleTemplate 也没有 styleTemplates，这套结构在导出时没有候选样式`
    })
  }

  checkStructureNode(root, '', 'root', id, out)
  checkCopyGroups(root, 'root', out)
  return out
}

/** 一个节点与其内容块（对应主进程的 checkStructureNode） */
function checkStructureNode(
  node: Record<string, unknown>,
  trail: string,
  path: string,
  id: string,
  out: TemplateIssueDto[]
): void {
  const where = whereOf(trail)
  const level = node['headingLevel']

  if (node['title'] === undefined) {
    out.push({
      level: 'warn',
      rule: 'node.title.missing',
      path: `${path}.title`,
      message: `${id}｜节点「${where}」没有 title`
    })
  }
  // lock 是块级字段：写在节点上不生效，节点级仍用 copyable / deletable / allowContentBlocks
  if ('lock' in node) {
    out.push({
      level: 'error',
      rule: 'node.lock.misplaced',
      path: `${path}.lock`,
      message:
        `${id}｜节点「${where}」把 lock 写在了节点上（不生效）——` +
        `块锁写进该节点的 contentBlocks[] 里，节点级用 copyable / deletable / allowContentBlocks`
    })
  }
  if (level !== undefined && (!Number.isInteger(level) || (level as number) < 0)) {
    out.push({
      level: 'error',
      rule: 'node.headingLevel.invalid',
      path: `${path}.headingLevel`,
      message: `${id}｜节点「${where}」的 headingLevel 非法：${text(JSON.stringify(level))}`
    })
  }
  if ((level as number) > 9) {
    out.push({
      level: 'warn',
      rule: 'node.headingLevel.deep',
      path: `${path}.headingLevel`,
      message: `${id}｜节点「${where}」的 headingLevel=${text(level)} 超深，Word 多级列表一般到 9 级`
    })
  }

  // copyable/deletable 缺省是 false，漏写会锁死节点
  if (
    node['copyable'] === undefined &&
    node['deletable'] === undefined &&
    node['nodeType'] !== 'root'
  ) {
    out.push({
      level: 'warn',
      rule: 'node.switches.absent',
      path,
      message:
        `${id}｜节点「${where}」未写 copyable/deletable，缺省都是 false（既不能复制也不能删除），确认是否有意为之`
    })
  }

  const blocks = asArray(node['contentBlocks'])
  for (let i = 0; i < blocks.length; i++) {
    const b = asObject(blocks[i])
    const bw = `${id}｜节点「${where}」第 ${i + 1} 个内容块`
    const bp = `${path}.contentBlocks[${i}]`
    if (!b) {
      out.push({
        level: 'error',
        rule: 'block.type.unknown',
        path: `${bp}.type`,
        message: `${bw}：未知 type=${text(JSON.stringify(undefined))}（程序会丢弃这一块）`
      })
      continue
    }
    if (!(KNOWN_BLOCK_TYPES as readonly string[]).includes(text(b['type']))) {
      out.push({
        level: 'error',
        rule: 'block.type.unknown',
        path: `${bp}.type`,
        message: `${bw}：未知 type=${text(JSON.stringify(b['type']))}（程序会丢弃这一块）`
      })
      continue
    }
    if (b['description'] !== undefined) {
      out.push({
        level: 'warn',
        rule: 'block.description.unread',
        path: `${bp}.description`,
        message: `${bw}：内容块上的 description 程序不读，提示到不了用户眼前；请把提示上提到节点的 description`
      })
    }
    // 块锁：只认 type / keep / readonly 三档，其它值程序按不锁处理并记警告
    if (b['lock'] !== undefined && !(LOCK_TIERS as readonly string[]).includes(text(b['lock']))) {
      out.push({
        level: 'error',
        rule: 'block.lock.invalid',
        path: `${bp}.lock`,
        message:
          `${bw}：lock 取值 ${text(JSON.stringify(b['lock']))} 不在 ${LOCK_TIERS.map(
            (x) => `"${x}"`
          ).join(' / ')} 之内` + `（程序按不锁处理：这一块会被当成普通块，锁白加了）`
      })
    }
    // 反向也别混：节点级字段写到块上程序不读
    for (const k of [
      'copyable',
      'deletable',
      'allowContentBlocks',
      'headingLevel',
      'title',
      'children'
    ]) {
      if (k in b) {
        out.push({
          level: 'error',
          rule: 'block.nodeField.misplaced',
          path: `${bp}.${k}`,
          message: `${bw}：块上写了节点级字段 ${k}（程序不读；节点级字段写在该节点上，块锁用 lock）`
        })
      }
    }
    if (b['type'] === 'text' && typeof b['content'] !== 'string') {
      out.push({
        level: 'error',
        rule: 'block.text.content',
        path: `${bp}.content`,
        message: `${bw}：text 必须给 content 字符串`
      })
    }
    if (
      (b['type'] === 'orderedList' || b['type'] === 'unorderedList') &&
      !Array.isArray(b['items'])
    ) {
      out.push({
        level: 'error',
        rule: 'block.list.items',
        path: `${bp}.items`,
        message: `${bw}：${text(b['type'])} 必须给 items 字符串数组`
      })
    }
    if (b['type'] === 'image') {
      if (typeof b['content'] !== 'string') {
        out.push({
          level: 'error',
          rule: 'block.image.content',
          path: `${bp}.content`,
          message: `${bw}：image 必须给 content（工程内相对路径，可为空串）`
        })
      }
      if (!b['caption']) {
        out.push({
          level: 'warn',
          rule: 'block.image.caption',
          path: `${bp}.caption`,
          message: `${bw}：image 没有 caption，导出后不会有图题`
        })
      }
    }
    if (b['type'] === 'mermaid') {
      if (!b['content']) {
        out.push({
          level: 'error',
          rule: 'block.mermaid.content',
          path: `${bp}.content`,
          message: `${bw}：mermaid 必须给 content（Mermaid 源码）`
        })
      }
      if (!b['caption']) {
        out.push({
          level: 'warn',
          rule: 'block.mermaid.caption',
          path: `${bp}.caption`,
          message: `${bw}：mermaid 没有 caption，导出后不会有图题`
        })
      }
    }
    if (b['type'] === 'code' && typeof b['content'] !== 'string') {
      out.push({
        level: 'error',
        rule: 'block.code.content',
        path: `${bp}.content`,
        message: `${bw}：code 必须给 content`
      })
    }

    if (b['type'] === 'table') checkTableBlock(b, bw, bp, out)
  }

  const children = asArray(node['children'])
  for (let i = 0; i < children.length; i++) {
    const child = asObject(children[i])
    if (!child) continue
    const childTrail = `${trail}/${text(node['title'] ?? '?')}`
    checkStructureNode(child, childTrail, `${path}.children[${i}]`, id, out)
  }
}

/** 表格块的形状检查（对应主进程的 checkTableBlock） */
function checkTableBlock(
  b: Record<string, unknown>,
  bw: string,
  bp: string,
  out: TemplateIssueDto[]
): void {
  const cols = Number(b['cols'])
  if (!Number.isInteger(cols) || cols <= 0) {
    out.push({
      level: 'error',
      rule: 'block.table.cols',
      path: `${bp}.cols`,
      message: `${bw}：cols 非法：${text(JSON.stringify(b['cols']))}`
    })
  }
  if (!Array.isArray(b['headers'])) {
    out.push({
      level: 'error',
      rule: 'block.table.headers',
      path: `${bp}.headers`,
      message: `${bw}：headers 必须是字符串数组`
    })
  } else if (b['headers'].length !== cols) {
    out.push({
      level: 'error',
      rule: 'block.table.headers.length',
      path: `${bp}.headers`,
      message: `${bw}：headers 长度 ${b['headers'].length} ≠ cols ${cols}`
    })
  }
  if (!Array.isArray(b['data'])) {
    out.push({
      level: 'error',
      rule: 'block.table.data',
      path: `${bp}.data`,
      message: `${bw}：data 必须是二维字符串数组`
    })
  } else {
    const data = b['data']
    const badRows = data.filter((r) => !Array.isArray(r))
    if (badRows.length > 0) {
      out.push({
        level: 'error',
        rule: 'block.table.data.rowNotArray',
        path: `${bp}.data`,
        message:
          `${bw}：data 有 ${badRows.length}/${data.length} 行不是数组，例：` +
          `${text(JSON.stringify(badRows[0]))}`
      })
    } else {
      const wrong = data.filter((r) => (r as unknown[]).length !== cols)
      if (wrong.length > 0) {
        out.push({
          level: 'error',
          rule: 'block.table.data.rowLength',
          path: `${bp}.data`,
          message:
            `${bw}：data 有 ${wrong.length} 行的列数 ≠ cols ${cols}，例：` +
            `${text(JSON.stringify(wrong[0])).slice(0, 60)}`
        })
      }
      // 两种口径都接受：rows = 正文行数，或 rows = 正文行数 + 1（把表头算进去）
      const declared = Number(b['rows'])
      if (declared !== data.length && declared !== data.length + 1) {
        out.push({
          level: 'warn',
          rule: 'block.table.rows',
          path: `${bp}.rows`,
          message:
            `${bw}：rows=${text(b['rows'])} 既不是正文行数 ${data.length}，也不是"含表头"的 ` +
            `${data.length + 1}；渲染取 min(rows, data.length)，多出的行不会显示`
        })
      }
    }
  }
  if (b['mergeVertical'] === true && Array.isArray(b['data'])) {
    out.push({
      level: 'warn',
      rule: 'block.table.mergeVertical.unread',
      path: `${bp}.mergeVertical`,
      message:
        `${bw}：开了 mergeVertical，但模板里的该字段目前不会被程序读进工程` +
        `（新建工程的表格不会合并，依据见 docs/06-常见问题与排错.md 第 8 节）`
    })
    const data = b['data']
    const flat = data.flat()
    const filled = flat.filter((c) => typeof c === 'string' && c.trim() !== '').length
    if (filled === 0) {
      out.push({
        level: 'warn',
        rule: 'block.table.mergeVertical.empty',
        path: `${bp}.data`,
        message:
          `${bw}：data 全是空串——即使合并开关生效也不会合并；想在模板里演示，` +
          `需在相邻行的同一列填相同的非空值`
      })
    }
  }
}

/** 复制组检查：只判"有 copyGroupId 但 copyable 不是 true" */
function checkCopyGroups(node: Record<string, unknown>, path: string, out: TemplateIssueDto[]): void {
  const children = asArray(node['children'])
  for (let i = 0; i < children.length; i++) {
    const c = asObject(children[i])
    if (!c) continue
    const childPath = `${path}.children[${i}]`
    if (c['copyGroupId']) {
      if (c['copyable'] !== true) {
        out.push({
          level: 'warn',
          rule: 'node.copyGroup.notCopyable',
          path: `${childPath}.copyable`,
          message:
            `节点「${text(c['title'])}」有 copyGroupId=${text(c['copyGroupId'])} 但 copyable 不是 true，` +
            `用户复制不了它`
        })
      }
    }
    checkCopyGroups(c, childPath, out)
  }
}

/** error / warn 计数：顶部与列表徽标都用它 */
export function countIssues(issues: readonly TemplateIssueDto[]): { errors: number; warnings: number } {
  let errors = 0
  let warnings = 0
  for (const issue of issues) {
    if (issue.level === 'error') errors += 1
    else warnings += 1
  }
  return { errors, warnings }
}

/** 这条结论落在不在某个位置下面（节点用它的 JSON 路径，块用 `${节点路径}.contentBlocks[i]`） */
export function issuesUnder(
  issues: readonly TemplateIssueDto[],
  path: string
): TemplateIssueDto[] {
  return issues.filter(
    (issue) => issue.path === path || issue.path.startsWith(`${path}.`)
  )
}
