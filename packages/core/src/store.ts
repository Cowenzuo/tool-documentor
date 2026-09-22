/**
 * SQLite 工程存储（node:sqlite 内建驱动 —— 免原生模块 ABI）。
 * 对齐旧版 ProjectStore 语义与 schema（实测旧库为准）：
 * - create 删除已存在文件并建 schema；
 * - save 在事务内全量重写（DELETE node/content_block → 递归 INSERT）；
 * - 根节点特殊写（parent NULL / heading 0 / node_type 'root'）；
 * - 时间戳为本地 ISO（yyyy-MM-ddTHH:mm:ss，无时区）。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { blockFromDb, blockTypeIndex, parseBlockType, propsOf } from './blocks'
import { seedIdCounter } from './idgen'
import { localIsoNow } from './time'
import { DocumentNode, DocumentTree } from './tree'
import type { ContentBlock } from './blocks'

export interface ProjectMeta {
  name: string
  /** 结构模板的 uuid（PLAN-12：引用只认 uuid，名字不参与匹配） */
  templateUuid: string
}

function str(v: unknown): string {
  return v == null ? '' : String(v)
}

function num(v: unknown): number {
  return v == null ? 0 : Number(v)
}

function bool(v: unknown): boolean {
  return v == null ? false : Number(v) !== 0
}

export class ProjectStore {
  private db: DatabaseSync | null = null
  private mDbPath = ''
  private mName = ''
  private mTemplateUuid = ''
  private loadWarningsValue: string[] = []

  // ================= 打开 / 创建 =================

  create(dbPath: string, projectName: string, templateUuid: string): void {
    this.close()
    rmSync(dbPath, { force: true })
    mkdirSync(dirname(dbPath), { recursive: true })

    const db = new DatabaseSync(dbPath)
    this.db = db
    this.mDbPath = dbPath
    this.mName = projectName
    this.mTemplateUuid = templateUuid
    db.exec('PRAGMA foreign_keys = ON')
    this.createSchema()

    const now = localIsoNow()
    db.prepare(
      'INSERT INTO project (name, template_uuid, created_at, updated_at) VALUES (?, ?, ?, ?)'
    ).run(projectName, templateUuid, now, now)
  }

  open(dbPath: string): void {
    this.close()
    const db = new DatabaseSync(dbPath)
    this.db = db
    this.mDbPath = dbPath
    db.exec('PRAGMA foreign_keys = ON')
    const row = db.prepare('SELECT name, template_uuid FROM project LIMIT 1').get()
    this.mName = row ? str(row['name']) : ''
    this.mTemplateUuid = row ? str(row['template_uuid']) : ''
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close()
      } catch {
        /* 已经关闭，忽略 */
      }
      this.db = null
    }
    this.mDbPath = ''
    this.mName = ''
    this.mTemplateUuid = ''
  }

  isOpen(): boolean {
    return this.db !== null
  }

  dbPath(): string {
    return this.mDbPath
  }

  projectName(): string {
    return this.mName
  }

  /** 这份工程用的是哪份结构模板（uuid） */
  templateUuid(): string {
    return this.mTemplateUuid
  }

  projectMeta(): ProjectMeta {
    return { name: this.mName, templateUuid: this.mTemplateUuid }
  }

  // ================= 表结构 =================

  private createSchema(): void {
    const db = this.requireDb()
    db.exec(
      'CREATE TABLE project (' +
        'id INTEGER PRIMARY KEY,' +
        "name TEXT NOT NULL," +
        "template_uuid TEXT NOT NULL," +
        "created_at TEXT NOT NULL," +
        "updated_at TEXT NOT NULL)"
    )
    db.exec(
      'CREATE TABLE node (' +
        'id TEXT PRIMARY KEY,' +
        'parent_id TEXT,' +
        'sort_order INTEGER NOT NULL DEFAULT 0,' +
        'heading_level INTEGER NOT NULL DEFAULT 1,' +
        "title TEXT DEFAULT ''," +
        "description TEXT DEFAULT ''," +
        "node_type TEXT DEFAULT ''," +
        'is_sub_title INTEGER NOT NULL DEFAULT 0,' +
        "sub_title_style TEXT DEFAULT ''," +
        'sub_title_auto_number INTEGER NOT NULL DEFAULT 1,' +
        'copyable INTEGER NOT NULL DEFAULT 0,' +
        'deletable INTEGER NOT NULL DEFAULT 0,' +
        'allow_content_blocks INTEGER NOT NULL DEFAULT 1,' +
        "copy_group_id TEXT DEFAULT ''," +
        "allowed_child_levels TEXT DEFAULT ''," +
        'FOREIGN KEY (parent_id) REFERENCES node(id) ON DELETE CASCADE)'
    )
    db.exec(
      'CREATE TABLE content_block (' +
        'id INTEGER PRIMARY KEY AUTOINCREMENT,' +
        'node_id TEXT NOT NULL,' +
        'sort_order INTEGER NOT NULL DEFAULT 0,' +
        'block_type TEXT NOT NULL,' +
        "props_json TEXT NOT NULL DEFAULT '{}'," +
        'FOREIGN KEY (node_id) REFERENCES node(id) ON DELETE CASCADE)'
    )
    db.exec(
      'CREATE TABLE ui_state (' +
        'key TEXT PRIMARY KEY,' +
        "value TEXT NOT NULL DEFAULT '')"
    )
  }

  // ================= 保存 =================

  save(tree: DocumentTree): void {
    const db = this.requireDb()
    const root = tree.root
    db.exec('BEGIN')
    try {
      db.exec('DELETE FROM content_block')
      db.exec('DELETE FROM node')

      // 根节点：列取默认值（heading 0 / node_type 'root'），但描述与内容块是真的用户数据，
      // 必须一起落库。历史上这两项被丢掉，界面从树面板根节点行走到它们时保存即失。
      db.prepare(
        "INSERT INTO node (id, parent_id, sort_order, heading_level, title, description, node_type) " +
          "VALUES (?, NULL, 0, 0, ?, ?, 'root')"
      ).run(root.id, root.title, root.description)

      this.saveBlocks(root)

      let order = 0
      for (const child of root.children) {
        this.saveNode(child, root.id, order)
        order += 1
      }

      db.prepare('UPDATE project SET updated_at = ?').run(localIsoNow())
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* 忽略：清理失败不影响关闭 */
      }
      throw err
    }
  }

  private saveBlocks(node: DocumentNode): void {
    const db = this.requireDb()
    const insertBlock = db.prepare(
      'INSERT INTO content_block (node_id, sort_order, block_type, props_json) VALUES (?, ?, ?, ?)'
    )
    let blockOrder = 0
    for (const block of node.contentBlocks) {
      insertBlock.run(
        node.id,
        blockOrder,
        String(blockTypeIndex(block.type)),
        JSON.stringify(propsOf(block))
      )
      blockOrder += 1
    }
  }

  private saveNode(node: DocumentNode, parentId: string, sortOrder: number): void {
    const db = this.requireDb()
    db.prepare(
      'INSERT INTO node (id, parent_id, sort_order, heading_level, title, description, ' +
        'node_type, is_sub_title, sub_title_style, sub_title_auto_number, ' +
        'copyable, deletable, allow_content_blocks, copy_group_id, allowed_child_levels) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      node.id,
      parentId,
      sortOrder,
      node.headingLevel,
      node.title,
      node.description,
      '', // nodeType：模板中定义，编辑时不变，暂不存储（与旧版一致）
      node.isSubTitle ? 1 : 0,
      node.subTitleStyle,
      node.subTitleAutoNumber ? 1 : 0,
      node.copyable ? 1 : 0,
      node.deletable ? 1 : 0,
      node.allowContentBlocks ? 1 : 0,
      node.copyGroupId,
      node.allowedChildLevels.join(',')
    )

    this.saveBlocks(node)

    let childOrder = 0
    for (const child of node.children) {
      this.saveNode(child, node.id, childOrder)
      childOrder += 1
    }
  }

  // ================= 加载 =================

  load(): DocumentTree {
    const db = this.requireDb()
    this.loadWarningsValue = []
    const rootRow = db
      .prepare('SELECT id, title, description FROM node WHERE parent_id IS NULL LIMIT 1')
      .get()
    if (!rootRow) {
      throw new Error('工程数据异常：缺少根节点')
    }
    const root = new DocumentNode(0, str(rootRow['id']))
    root.title = str(rootRow['title'])
    root.description = str(rootRow['description'])
    this.loadBlocks(root)
    this.loadChildren(root)
    const tree = new DocumentTree(root)
    // 计数器越过现存最大数字 id，避免新节点与旧 id 冲突
    let maxNumeric = 0
    for (const id of tree.collectIds()) {
      const parsed = Number.parseInt(id, 10)
      if (Number.isFinite(parsed) && parsed > maxNumeric) maxNumeric = parsed
    }
    seedIdCounter(maxNumeric)
    return tree
  }

  /** 上次 load 遇到的问题（目前只有"内容块类型无法识别，已跳过"） */
  loadWarnings(): string[] {
    return [...this.loadWarningsValue]
  }

  private loadChildren(parent: DocumentNode): void {
    const db = this.requireDb()
    const rows = db.prepare('SELECT id FROM node WHERE parent_id = ? ORDER BY sort_order').all(parent.id)
    for (const row of rows) {
      const child = this.loadNode(str(row['id']))
      if (!child) continue
      child.parent = parent
      parent.children.push(child)
      this.loadChildren(child)
    }
  }

  private loadNode(nodeId: string): DocumentNode | null {
    const db = this.requireDb()
    const row = db
      .prepare(
        'SELECT heading_level, title, description, is_sub_title, sub_title_style, ' +
          'sub_title_auto_number, copyable, deletable, allow_content_blocks, ' +
          'copy_group_id, allowed_child_levels FROM node WHERE id = ?'
      )
      .get(nodeId)
    if (!row) return null

    const node = new DocumentNode(num(row['heading_level']), nodeId)
    node.title = str(row['title'])
    node.description = str(row['description'])
    node.isSubTitle = bool(row['is_sub_title'])
    node.subTitleStyle = str(row['sub_title_style'])
    node.subTitleAutoNumber = bool(row['sub_title_auto_number'])
    node.copyable = bool(row['copyable'])
    node.deletable = bool(row['deletable'])
    node.allowContentBlocks = bool(row['allow_content_blocks'])
    node.copyGroupId = str(row['copy_group_id'])
    const levels = str(row['allowed_child_levels'])
    if (levels) {
      node.allowedChildLevels = levels.split(',').filter((x) => x.length > 0)
    }

    this.loadBlocks(node)
    return node
  }

  /**
   * 读内容块。类型无法识别时**跳过这一块并记一条警告**，不抛错。
   * 抛错会让整个工程打不开（历史上写入过 -1 的项目就是这样坏掉的）；
   * 跳过至少让用户能打开、能看见缺了什么，打开工程时会把警告弹给用户。
   */
  private loadBlocks(node: DocumentNode): void {
    const db = this.requireDb()
    const blockRows = db
      .prepare(
        'SELECT block_type, props_json FROM content_block WHERE node_id = ? ORDER BY sort_order'
      )
      .all(node.id)
    for (const brow of blockRows) {
      const rawType = str(brow['block_type'])
      const name = parseBlockType(rawType)
      if (!name) {
        this.loadWarningsValue.push(`节点 ${node.id} 有一个无法识别的内容块类型 ${rawType}，已跳过`)
        continue
      }
      let props: Record<string, unknown>
      try {
        props = JSON.parse(str(brow['props_json'])) as Record<string, unknown>
      } catch {
        props = {}
      }
      const block: ContentBlock = blockFromDb(name, props)
      node.contentBlocks.push(block)
    }
  }

  // ================= UI 状态 =================

  saveUiState(key: string, value: string): void {
    const db = this.requireDb()
    db.prepare('INSERT OR REPLACE INTO ui_state (key, value) VALUES (?, ?)').run(key, value)
  }

  loadUiState(key: string, defaultValue = ''): string {
    const db = this.requireDb()
    const row = db.prepare('SELECT value FROM ui_state WHERE key = ?').get(key)
    return row ? str(row['value']) : defaultValue
  }

  loadAllUiState(): Record<string, string> {
    const db = this.requireDb()
    const rows = db.prepare('SELECT key, value FROM ui_state').all()
    const result: Record<string, string> = {}
    for (const row of rows) {
      result[str(row['key'])] = str(row['value'])
    }
    return result
  }

  // ================= 内部 =================

  private requireDb(): DatabaseSync {
    if (!this.db) throw new Error('工程数据库未打开')
    return this.db
  }
}
