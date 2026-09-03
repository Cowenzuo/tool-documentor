import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  anchorPath,
  dbPathOf,
  DEFAULT_DB_FILE,
  readAnchor,
  writeAnchor
} from '../src/anchor'

describe('工程锚点 documentor.dproj', () => {
  it('读写往返 + 默认 db_file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-anchor-'))
    try {
      const anchor = {
        version: 1,
        name: '测试工程',
        template: '示例模板',
        db_file: 'custom.db',
        created_at: '2026-07-23T15:35:47',
        updated_at: '2026-07-23T15:35:47'
      }
      writeAnchor(dir, anchor)
      const read = readAnchor(dir)
      expect(read).toEqual(anchor)
      expect(anchorPath(dir)).toBe(join(dir, 'documentor.dproj'))
      expect(dbPathOf(dir, anchor)).toBe(join(dir, 'custom.db'))
      // 文件为 UTF-8 JSON（中文完好）
      const raw = readFileSync(anchorPath(dir), 'utf8')
      expect(raw).toContain('测试工程')
      expect(raw).toContain('示例模板')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('缺 db_file 时回退默认名', () => {
    const dir = mkdtempSync(join(tmpdir(), 'doc-anchor2-'))
    try {
      writeAnchor(dir, {
        version: 1,
        name: 'n',
        template: 't',
        db_file: DEFAULT_DB_FILE,
        created_at: 'x',
        updated_at: 'y'
      })
      const raw = JSON.parse(readFileSync(anchorPath(dir), 'utf8')) as { db_file?: string }
      expect(raw.db_file).toBe('documentor.db')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('解析合成样例工程锚点', () => {
    const fixtureDir = join(
      __dirname,
      '../../../resources/test-fixtures/sample-project'
    )
    const anchor = readAnchor(fixtureDir)
    expect(anchor).not.toBeNull()
    expect(anchor!.name).toBe('示例工程')
    expect(anchor!.template).toBe('示例文档模板 (Demo)')
    expect(anchor!.db_file).toBe('documentor.db')
    expect(anchor!.version).toBe(1)
    expect(anchor!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/)
  })

  it('缺失文件返回 null', () => {
    expect(readAnchor('Z:/no/such/project')).toBeNull()
  })
})
