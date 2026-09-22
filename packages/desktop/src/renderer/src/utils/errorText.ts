/**
 * 失败提示的统一取词：主进程抛回来的 message 本来就是给人看的中文结论
 * （`工程数据库不存在：…`、`该章节不允许删除`、`模板规定该内容为定稿，内容不能改`）。
 * 统一写成"操作失败"会让用户只能猜，出问题时连一句能拿来定位的话都没有。
 *
 * 各处的用法是"这一步做什么：原因"，例如 `导出失败：找不到这份样式模板，可能已经被删除`。
 */
export function errorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  return text.trim() === '' ? '操作失败' : text
}
