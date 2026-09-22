/**
 * 即时校验（渲染层）：身份字段、结构模板的节点树与内容块规则，判定条件与文案逐条对齐
 * `packages/templates/src/validate.ts` 的 `validateStructureTemplate`，
 * 让人改动后立刻看到结论，而不是等到保存被主进程打回。
 *
 * 为什么是镜像而不是直接 import 那个包：它在模块顶层 import 了 `node:fs`
 * （读骨架用），出口 index 还会带出 `manager.ts` → `@documentor/core`（库里带原生模块）。
 * 渲染层打进浏览器包时，node 内置模块会被替换成只有 default 的 shim，具名导入当场报错。
 * 所以这里只镜像**单份模板能判的规则**（身份、节点开关、内容块字段、表格形状、
 * 锁取值、复制组）。
 *
 * 保存仍以主进程的校验为准：这里只决定按钮亮不亮、以及问题列表长什么样。
 */
import type { TemplateIssueDto } from '../../../../shared/project'

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

/** 身份只认 uuid（与 `@documentor/templates` 的 isTemplateUuid 同一条正则） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

/**
 * 校验一份结构模板 JSON 原文（`{ uuid, cn, en, root }`）。
 * `path` 与主进程同一套写法：`root.children[2].contentBlocks[0].lock`。
 */
export function validateStructureDoc(def: unknown): TemplateIssueDto[] {
  const out: TemplateIssueDto[] = []
  const doc = asObject(def) ?? {}

  const uuid = doc['uuid']
  if (typeof uuid !== 'string' || !UUID_RE.test(uuid)) {
    out.push({
      level: 'error',
      rule: 'structure.uuid.invalid',
      path: 'uuid',
      message: `顶层uuid缺失或非法`
    })
  }
  const cn = doc['cn']
  if (typeof cn !== 'string' || cn.trim() === '') {
    out.push({
      level: 'error',
      rule: 'structure.cn.missing',
      path: 'cn',
      message: `顶层cn缺失`
    })
  }
  const root = asObject(doc['root'])
  if (!root) {
    out.push({
      level: 'error',
      rule: 'structure.root.missing',
      path: 'root',
      message: `顶层root缺失`
    })
    return out
  }

  checkStructureNode(root, 'root', out)
  checkCopyGroups(root, 'root', out)
  return out
}

/**
 * 一个节点与其内容块（对应主进程的 checkStructureNode）。
 * 结论只说事实，位置由看的人按 path 自己标：块卡片就在旁边，页脚那份索引按位置归堆。
 */
function checkStructureNode(
  node: Record<string, unknown>,
  path: string,
  out: TemplateIssueDto[]
): void {
  const level = node['headingLevel']

  if (node['title'] === undefined) {
    out.push({
      level: 'warn',
      rule: 'node.title.missing',
      path: `${path}.title`,
      message: `title缺失`
    })
  }
  // lock 是块级字段：写在节点上不生效，节点级仍用 copyable / deletable / allowContentBlocks
  if ('lock' in node) {
    out.push({
      level: 'error',
      rule: 'node.lock.misplaced',
      path: `${path}.lock`,
      message: `lock位置错误`
    })
  }
  if (level !== undefined && (!Number.isInteger(level) || (level as number) < 0)) {
    out.push({
      level: 'error',
      rule: 'node.headingLevel.invalid',
      path: `${path}.headingLevel`,
      message: `headingLevel非法`
    })
  }
  if ((level as number) > 9) {
    out.push({
      level: 'warn',
      rule: 'node.headingLevel.deep',
      path: `${path}.headingLevel`,
      message: `headingLevel超深`
    })
  }

  // copyable/deletable 缺省是 false，但界面上的开关本来就是没勾的样子，不另报

  // 排版开关缺省是 true（可编排）；写歪了程序按缺省处理，所以报出来
  if (node['allowLayoutEdit'] !== undefined && typeof node['allowLayoutEdit'] !== 'boolean') {
    out.push({
      level: 'error',
      rule: 'node.allowLayoutEdit.invalid',
      path: `${path}.allowLayoutEdit`,
      message: `allowLayoutEdit需为布尔值`
    })
  }

  // defaultStyleUuid 是整份模板级的字段：写在节点上程序不读，界面选了也不生效
  if ('defaultStyleUuid' in node) {
    out.push({
      level: 'error',
      rule: 'node.defaultStyleUuid.misplaced',
      path: `${path}.defaultStyleUuid`,
      message: `defaultStyleUuid位置错误`
    })
  }

  const blocks = asArray(node['contentBlocks'])
  for (let i = 0; i < blocks.length; i++) {
    const b = asObject(blocks[i])
    const bp = `${path}.contentBlocks[${i}]`
    if (!b) {
      out.push({
        level: 'error',
        rule: 'block.type.unknown',
        path: `${bp}.type`,
        message: `type 未知：${text(JSON.stringify(undefined))} · 该块会被丢弃`
      })
      continue
    }
    if (!(KNOWN_BLOCK_TYPES as readonly string[]).includes(text(b['type']))) {
      out.push({
        level: 'error',
        rule: 'block.type.unknown',
        path: `${bp}.type`,
        message: `type 未知：${text(JSON.stringify(b['type']))} · 该块会被丢弃`
      })
      continue
    }
    if (b['description'] !== undefined) {
      out.push({
        level: 'warn',
        rule: 'block.description.unread',
        path: `${bp}.description`,
        message: `description 写在块上不读取`
      })
    }
    // 块锁：认 keep / readonly 两档，外加已作废的 type；其它值程序按自由编辑处理并记警告
    const rawLock = b['lock']
    const lock = rawLock === undefined ? '' : text(rawLock)
    if (rawLock !== undefined && !(LOCK_TIERS as readonly string[]).includes(lock)) {
      out.push({
        level: 'error',
        rule: 'block.lock.invalid',
        path: `${bp}.lock`,
        message:
          `lock 取值 ${text(JSON.stringify(rawLock))} 不属于 ` +
          `${LOCK_TIERS.map((x) => `"${x}"`).join(' / ')} · 按自由编辑处理`
      })
    } else if (lock === 'type') {
      out.push({
        level: 'warn',
        rule: 'block.lock.legacy',
        path: `${bp}.lock`,
        message: `lock 档位 type 已作废`
      })
    }
    // 反向也别混：节点级字段写到块上程序不读
    for (const k of [
      'copyable',
      'deletable',
      'allowContentBlocks',
      'allowLayoutEdit',
      'headingLevel',
      'title',
      'children'
    ]) {
      if (k in b) {
        out.push({
          level: 'error',
          rule: 'block.nodeField.misplaced',
          path: `${bp}.${k}`,
          message: `${k} 是节点级字段 · 块上不读取`
        })
      }
    }
    if (b['type'] === 'text' && typeof b['content'] !== 'string') {
      out.push({
        level: 'error',
        rule: 'block.text.content',
        path: `${bp}.content`,
        message: `content缺失`
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
        message: `items缺失`
      })
    }
    if (b['type'] === 'image') {
      if (typeof b['content'] !== 'string') {
        out.push({
          level: 'error',
          rule: 'block.image.content',
          path: `${bp}.content`,
          message: `content缺失`
        })
      }
      if (!b['caption']) {
        out.push({
          level: 'warn',
          rule: 'block.image.caption',
          path: `${bp}.caption`,
          message: `图题缺失`
        })
      }
    }
    if (b['type'] === 'mermaid') {
      if (!b['content']) {
        out.push({
          level: 'error',
          rule: 'block.mermaid.content',
          path: `${bp}.content`,
          message: `content缺失`
        })
      }
      if (!b['caption']) {
        out.push({
          level: 'warn',
          rule: 'block.mermaid.caption',
          path: `${bp}.caption`,
          message: `图题缺失`
        })
      }
    }
    if (b['type'] === 'code' && typeof b['content'] !== 'string') {
      out.push({
        level: 'error',
        rule: 'block.code.content',
        path: `${bp}.content`,
        message: `content缺失`
      })
    }

    if (b['type'] === 'table') checkTableBlock(b, bp, out)
  }

  const children = asArray(node['children'])
  for (let i = 0; i < children.length; i++) {
    const child = asObject(children[i])
    if (!child) continue
    checkStructureNode(child, `${path}.children[${i}]`, out)
  }
}

/** 表格块的形状检查（对应主进程的 checkTableBlock） */
function checkTableBlock(
  b: Record<string, unknown>,
  bp: string,
  out: TemplateIssueDto[]
): void {
  const cols = Number(b['cols'])
  if (!Number.isInteger(cols) || cols <= 0) {
    out.push({
      level: 'error',
      rule: 'block.table.cols',
      path: `${bp}.cols`,
      message: `cols 非法：${text(JSON.stringify(b['cols']))}`
    })
  }
  if (!Array.isArray(b['headers'])) {
    out.push({
      level: 'error',
      rule: 'block.table.headers',
      path: `${bp}.headers`,
      message: `headers 需为字符串数组`
    })
  } else if (b['headers'].length !== cols) {
    out.push({
      level: 'error',
      rule: 'block.table.headers.length',
      path: `${bp}.headers`,
      message: `headers ${b['headers'].length} 列 ≠ cols ${cols}`
    })
  }
  if (!Array.isArray(b['data'])) {
    out.push({
      level: 'error',
      rule: 'block.table.data',
      path: `${bp}.data`,
      message: `data 需为二维字符串数组`
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
          `data 有 ${badRows.length}/${data.length} 行不是数组 · 例 ` +
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
            `data 有 ${wrong.length} 行列数 ≠ cols ${cols} · 例 ` +
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
          // 与主进程同一份说法：只说对不上
          message: `rows=${text(b['rows'])} ≠ 正文行数 ${data.length}（含表头 ${data.length + 1}）`
        })
      }
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
          // 与主进程同一份说法：结论挂在这个节点自己身上，不重复它的名字
          message: `copyGroupId 在，copyable 不是 true · 复制不了`
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
