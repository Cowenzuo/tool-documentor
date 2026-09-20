/**
 * 模板编辑页（PLAN-11 批次 2）：整页独立，不打开工程、不进撤销栈、不挂编辑器的组件树。
 * 三栏：左栏模板列表（目录与模板、问题徽标），中栏节点树，右栏选中节点的表单。
 * 改动只落在内存草稿里，写文件只发生在页脚那个「保存」按钮。
 */
import { useEffect, useState, type JSX } from 'react'
import { useApp } from '../state/AppContext'
import NodeForm from '../components/template/NodeForm'
import NodeTree from '../components/template/NodeTree'
import TemplateList from '../components/template/TemplateList'
import { IssueLines } from '../components/template/fields'
import { countBlocks, countNodes, nodeJsonPath } from '../components/template/templateDoc'
import { countIssues, issuesUnder } from '../components/template/templateValidate'
import { useTemplateEditor } from '../components/template/useTemplateEditor'
import '../components/template/template.css'

export default function TemplateEditorPage(): JSX.Element {
  const { closeTemplateEditor } = useApp()
  const editor = useTemplateEditor()
  const counts = countIssues(editor.issues)
  const hasErrors = counts.errors > 0
  const open = editor.doc !== null

  /**
   * 问题清单的展开状态：出现 error 时自动摊开，之后由用户自己开关。
   * 不直接把 open 绑到 counts.errors 上——那样每敲一个字都会被重新渲染按回去。
   */
  const [issuesOpen, setIssuesOpen] = useState(false)
  useEffect(() => {
    if (hasErrors) setIssuesOpen(true)
  }, [hasErrors])

  const nodeIssues = editor.selectedNode
    ? issuesUnder(editor.issues, nodeJsonPath(editor.selectedPath))
    : []

  /** 保存按钮为什么不能按：一句话说清，按钮上也有同样的 title */
  const saveWhy = !open
    ? '没有打开模板'
    : counts.errors > 0
      ? `有 ${counts.errors} 个错误，先改好再保存`
      : !editor.dirty
        ? '没有未保存的改动'
        : editor.busy
          ? '正在处理…'
          : ''
  const canSave = open && editor.dirty && counts.errors === 0 && !editor.busy

  const dirs = editor.snapshot?.dirs ?? []

  return (
    <div className="tpl-page">
      <header className="tpl-top">
        <h1 className="tpl-top-title">模板编辑</h1>
        <label className="tpl-dir">
          <span className="tpl-count">模板目录</span>
          <select
            className="tpl-select tpl-dir-select"
            value={editor.dir ?? ''}
            disabled={dirs.length === 0 || editor.busy}
            onChange={(event) => editor.requestDir(event.target.value)}
          >
            {dirs.map((item) => (
              <option key={item.dir} value={item.dir}>
                {item.dir}
              </option>
            ))}
            {dirs.length === 0 && (
              <option value="">
                {editor.status === 'ready' ? '（没配置模板目录）' : '正在读取…'}
              </option>
            )}
          </select>
        </label>
        <button
          type="button"
          className="tpl-mini"
          disabled={editor.busy}
          onClick={editor.requestReload}
        >
          重新加载
        </button>
        <span className="tpl-top-counts">
          {open ? (
            <>
              <span className="tpl-count">
                {countNodes(editor.doc)} 个节点 · {countBlocks(editor.doc)} 个内容块
              </span>
              {counts.errors > 0 && (
                <span className="tpl-badge tpl-badge-error">{counts.errors} 个错误</span>
              )}
              {counts.warnings > 0 && (
                <span className="tpl-badge tpl-badge-warn">{counts.warnings} 处提示</span>
              )}
              {counts.errors === 0 && counts.warnings === 0 && (
                <span className="tpl-count">没有发现问题</span>
              )}
            </>
          ) : (
            <span className="tpl-count">
              {editor.status === 'ready' ? '没有打开模板' : '正在读取模板目录…'}
            </span>
          )}
        </span>
        <span className="tpl-top-gap" />
        {editor.dirty && <span className="tpl-dirty">改动未保存</span>}
        <button type="button" className="tpl-mini" onClick={closeTemplateEditor}>
          关闭
        </button>
      </header>

      {editor.pending && (
        <div className="tpl-strip tpl-strip-warn" role="alertdialog" aria-label="有未保存的改动">
          <span>
            {editor.pending.kind === 'reload'
              ? '有未保存的改动，重新加载就会丢掉。'
              : '有未保存的改动，换一份模板就会丢掉。'}
          </span>
          <button type="button" className="tpl-mini" onClick={editor.cancelPending}>
            取消
          </button>
          <button type="button" className="tpl-mini tpl-danger" onClick={editor.confirmPending}>
            {editor.pending.kind === 'reload' ? '丢掉改动并重新加载' : '丢掉改动并切换'}
          </button>
        </div>
      )}

      {editor.notice && (
        <div className={`tpl-strip tpl-strip-${editor.notice.kind}`}>
          <span>{editor.notice.text}</span>
          {editor.notice.detail &&
            (editor.notice.kind === 'error' ? (
              <code className="tpl-raw">{editor.notice.detail}</code>
            ) : (
              <details className="tpl-detail">
                <summary>备份位置</summary>
                <code className="tpl-path">{editor.notice.detail}</code>
              </details>
            ))}
          <button type="button" className="tpl-mini" aria-label="关闭提示" onClick={editor.dismissNotice}>
            ✕
          </button>
        </div>
      )}

      <div className="tpl-body">
        <TemplateList
          status={editor.status}
          dirSnapshot={editor.dirSnapshot}
          selectedId={editor.entry?.id ?? null}
          busy={editor.busy}
          dirty={editor.dirty}
          onOpen={editor.requestEntry}
          onCreate={editor.createTemplate}
          onRename={editor.renameTemplate}
          onRemove={editor.removeTemplate}
        />
        <NodeTree
          doc={editor.doc}
          status={editor.status}
          selectedPath={editor.selectedPath}
          expanded={editor.expanded}
          issues={editor.issues}
          onSelect={editor.selectNode}
          onToggle={editor.toggleExpand}
          onExpandAll={editor.expandAll}
          onCollapseAll={editor.collapseAll}
        />
        <NodeForm
          doc={editor.doc}
          status={editor.status}
          node={editor.selectedNode}
          path={editor.selectedPath}
          issues={nodeIssues}
          nodeTypes={editor.nodeTypes}
          canMove={editor.canMoveSelected}
          onPatch={editor.patchSelectedNode}
          onAddChild={editor.addChildNode}
          onAddSibling={editor.addSiblingNode}
          onMove={editor.moveSelectedNode}
          onRemove={editor.removeSelectedNode}
          onBlockPatch={editor.patchBlock}
          onBlockMove={editor.moveBlock}
          onBlockRemove={editor.removeBlock}
          onBlockAdd={editor.addBlock}
        />
      </div>

      <footer className="tpl-foot">
        <div className="tpl-foot-issues">
          {editor.issues.length === 0 ? (
            <span className="tpl-count">{open ? '校验通过' : ''}</span>
          ) : (
            <details open={issuesOpen} onToggle={(event) => setIssuesOpen(event.currentTarget.open)}>
              <summary>
                {counts.errors} 个错误 · {counts.warnings} 处提示
                {editor.issuesSource === 'server' ? '（主进程的结论）' : ''}
              </summary>
              <div className="tpl-foot-issue-list">
                <IssueLines issues={editor.issues} />
              </div>
            </details>
          )}
        </div>
        <div className="tpl-foot-save">
          {editor.saveResult && (
            <>
              <span className="tpl-count">已保存 {editor.saveResult.savedAt.slice(11, 19)}</span>
              {editor.saveResult.backupPath ? (
                <details className="tpl-detail">
                  <summary>备份位置</summary>
                  <code className="tpl-path">{editor.saveResult.backupPath}</code>
                </details>
              ) : (
                <span className="tpl-count">首次保存，没有可备份的原文件</span>
              )}
            </>
          )}
          <button
            type="button"
            className="tpl-mini tpl-primary"
            disabled={!canSave}
            title={saveWhy || '写入这份模板文件'}
            onClick={() => void editor.save()}
          >
            保存
          </button>
          {saveWhy && <span className="tpl-count">{saveWhy}</span>}
        </div>
      </footer>
    </div>
  )
}
