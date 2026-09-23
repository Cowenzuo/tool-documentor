/**
 * dialog-path.ts — 浏览对话框的起始位置。
 *
 * 为什么不给 `defaultPath` 不行：Electron 会落到**进程工作目录**，打包安装后那就是 C 盘
 * 某个角落（安装目录/System32），用户每次都得从 C 盘一路点回自己的工程目录。
 *
 * 所以这里定一份优先级，全仓库只有这一处算它：
 *   调用方给的现值（设置里已填的目录、块上已选的图片路径）→ 当前工程目录 →
 *   设置里的默认工程目录 → 系统文档目录。
 *
 * 两个细节：
 *   - 给的是文件（选图片、选 node.exe、选 .docx）就取它所在的目录；
 *   - 路径不存在就跳过这一档（用户可能填了个还没建的目录），继续往下退。
 *
 * 纯函数、不碰 Electron，所以能在单测里直接跑。
 */
import { statSync } from 'node:fs'
import { dirname } from 'node:path'

export interface DialogStartInput {
  /** 调用方给的现值：设置里已填的目录、块上已选的图片路径 */
  given?: string
  /** 当前打开的工程目录；没开工程就是空串 */
  projectDir?: string
  /** 设置 → 默认工程目录 */
  defaultProjectDir?: string
  /** 系统文档目录（主进程传 `app.getPath('documents')`） */
  documentsDir?: string
  /** 判断是不是目录；缺省探真实文件系统（单测注入假实现） */
  isDirectory?: (path: string) => boolean
}

export function dialogStartDir(input: DialogStartInput): string | undefined {
  const isDir =
    input.isDirectory ??
    ((path: string): boolean => {
      try {
        return statSync(path).isDirectory()
      } catch {
        return false
      }
    })

  /** 这一档能不能当起始目录用：本身是目录就用它，是文件就用它所在的目录，都没有就作废 */
  const asDir = (value: string | undefined): string | undefined => {
    const raw = (value ?? '').trim()
    if (raw === '') return undefined
    if (isDir(raw)) return raw
    const parent = dirname(raw)
    return parent !== raw && isDir(parent) ? parent : undefined
  }

  for (const candidate of [
    input.given,
    input.projectDir,
    input.defaultProjectDir,
    input.documentsDir
  ]) {
    const dir = asDir(candidate)
    if (dir) return dir
  }
  return undefined
}
