/**
 * 主进程 IPC 注册：工程/树/块/对话框/设置/模板查询。
 * handler 抛错统一转为 rejection（renderer 侧可捕获 message）。
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { buildTemplateManager } from './services/template-host'
import type {
  AppConfigDto,
  BlockAddInput,
  BlockIndexInput,
  BlockMoveInput,
  BlockUpdateInput,
  CreateProjectInput,
  ExportDocxInput,
  FileWriteBytesInput,
  FigureCountsDto,
  HistoryResultDto,
  HistoryStateDto,
  ImageImportInput,
  NodeCopyInput,
  NodeDeleteInput,
  NodeDescriptionInput,
  NodeTitleInput,
  StyleCandidateDto,
  StyleTemplateDto,
  StructureTemplateDto,
  TemplateLoadReport,
  UiStateKeyInput
} from '../shared/project'
import { ProjectIpc } from '../shared/project'
import {
  addRecentProject,
  loadAppSettings,
  loadRecents,
  saveAppSettings
} from './services/config'
import { ProjectServiceError } from './services/project-service'
import type { ProjectService } from './services/project-service'

type Handler<T, R> = (arg: T) => R | Promise<R>

function handle<T, R>(channel: string, fn: Handler<T, R>): void {
  ipcMain.handle(channel, async (_event, arg: T): Promise<R> => {
    try {
      return await fn(arg)
    } catch (err) {
      // renderer 通过 error message 展示
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  })
}

function windowOf(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
}

export function registerProjectIpc(service: ProjectService): void {
  // ---------- 工程 ----------
  handle<CreateProjectInput, Awaited<ReturnType<ProjectService['createProject']>>>(
    ProjectIpc.ProjectCreate,
    (input) => {
      const result = service.createProject(input)
      addRecentProject(result.info.dprojPath)
      return result
    }
  )

  handle<string, Awaited<ReturnType<ProjectService['openProject']>>>(
    ProjectIpc.ProjectOpen,
    (dprojPath) => {
      const result = service.openProject(dprojPath)
      addRecentProject(result.info.dprojPath)
      return result
    }
  )

  handle<void, void>(ProjectIpc.ProjectClose, () => {
    const result = service.saveAndCloseProject()
    // 保存失败时工程仍开着：必须把错误抛回渲染层，不能让它以为已经关掉了
    if (!result.ok) throw new ProjectServiceError(`保存失败，工程未关闭：${result.error}`)
  })

  handle<void, Awaited<ReturnType<ProjectService['saveProject']>>>(ProjectIpc.ProjectSave, () =>
    service.saveProject()
  )

  handle<void, boolean>(ProjectIpc.ProjectIsOpen, () => service.isOpen)

  // 预览按导出栏宽排版：栏宽取自样式骨架的 sectPr，解析不到返回 null 由界面兜底
  handle<void, number | null>(ProjectIpc.ProjectPageTextWidth, () =>
    service.pageTextWidthTwips()
  )

  handle<void, Awaited<ReturnType<ProjectService['precheck']>>>(ProjectIpc.ProjectPrecheck, () =>
    service.precheck()
  )

  handle<void, Awaited<ReturnType<ProjectService['projectInfo']>>>(ProjectIpc.ProjectGetInfo, () =>
    service.projectInfo()
  )

  // 定位：在系统文件管理器里打开工程目录。工程没打开就没有可打开的位置。
  handle<void, string>(ProjectIpc.ProjectRevealFolder, async () => {
    const info = service.projectInfo()
    if (!info.projectDir) throw new ProjectServiceError('工程未打开')
    const failure = await shell.openPath(info.projectDir)
    if (failure) throw new ProjectServiceError(`打开工程目录失败：${failure}`)
    return info.projectDir
  })

  // ---------- 树 ----------
  handle<void, Awaited<ReturnType<ProjectService['openResult']>>>(ProjectIpc.TreeGetRoot, () =>
    service.treeGetRoot()
  )

  handle<NodeTitleInput, void>(ProjectIpc.NodeUpdateTitle, (input) =>
    service.setNodeTitle(input)
  )
  handle<NodeDescriptionInput, void>(ProjectIpc.NodeUpdateDescription, (input) =>
    service.setNodeDescription(input)
  )
  handle<NodeCopyInput, Awaited<ReturnType<ProjectService['copyNode']>>>(
    ProjectIpc.NodeCopy,
    (input) => service.copyNode(input)
  )
  handle<NodeDeleteInput, void>(ProjectIpc.NodeDelete, (input) => service.deleteNode(input))

  // ---------- 撤销与重做 ----------
  // 返回与打开工程同形状的整树 + 历史状态，界面整棵替换
  handle<void, HistoryResultDto>(ProjectIpc.HistoryUndo, () => service.undo())
  handle<void, HistoryResultDto>(ProjectIpc.HistoryRedo, () => service.redo())
  handle<void, HistoryStateDto>(ProjectIpc.HistoryState, () => service.historyState())

  // ---------- 内容块 ----------
  handle<BlockAddInput, number>(ProjectIpc.BlockAdd, (input) => service.addBlock(input))
  handle<BlockIndexInput, number>(ProjectIpc.BlockRemove, (input) => service.removeBlock(input))
  handle<BlockMoveInput, void>(ProjectIpc.BlockMove, (input) => service.moveBlock(input))
  handle<BlockUpdateInput, void>(ProjectIpc.BlockUpdate, (input) => service.updateBlock(input))
  handle<ImageImportInput, Awaited<ReturnType<ProjectService['importImage']>>>(
    ProjectIpc.ImageImport,
    (input) => service.importImage(input)
  )
  handle<FileWriteBytesInput, string>(ProjectIpc.FileWriteBytes, (input) =>
    service.writeProjectFile(input)
  )
  handle<string, string | null>(ProjectIpc.FileReadDataUrl, (relPath) =>
    service.readProjectFileDataUrl(relPath)
  )

  // ---------- UI 状态 ----------
  handle<{ key: string; value: string }, void>(ProjectIpc.UiStateSave, (input) => {
    service.saveUiState(input.key, input.value)
  })
  handle<UiStateKeyInput, string>(ProjectIpc.UiStateLoad, (input) =>
    service.loadUiState(input.key)
  )

  // ---------- 对话框 ----------
  handle<void, string | null>(ProjectIpc.DialogSelectDproj, async () => {
    const win = windowOf()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '打开工程',
      filters: [{ name: 'Documentor 工程', extensions: ['dproj'] }],
      properties: ['openFile']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!
  })

  handle<void, string | null>(ProjectIpc.DialogSelectDirectory, async () => {
    const win = windowOf()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择目录',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!
  })

  handle<void, string | null>(ProjectIpc.DialogSelectImage, async () => {
    const win = windowOf()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择图片',
      filters: [
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'emf'] }
      ],
      properties: ['openFile']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!
  })

  handle<{ defaultPath: string }, string | null>(ProjectIpc.DialogSavePath, async (input) => {
    const win = windowOf()
    if (!win) return null
    const result = await dialog.showSaveDialog(win, {
      title: '导出 DOCX',
      defaultPath: input.defaultPath,
      filters: [
        { name: 'Word 文档', extensions: ['docx'] },
        { name: 'Markdown（预留）', extensions: ['md'] }
      ]
    })
    return result.canceled || !result.filePath ? null : result.filePath
  })

  // ---------- 设置与模板 ----------
  handle<void, AppConfigDto>(ProjectIpc.SettingsGet, () => {
    const settings = loadAppSettings()
    return {
      version: settings.version,
      default_project_dir: settings.default_project_dir,
      template_dirs: settings.template_dirs,
      recents: loadRecents()
    }
  })

  handle<Partial<AppConfigDto>, void>(ProjectIpc.SettingsSet, (patch) => {
    // 先落盘再重建：buildTemplateManager 读的是 settings.template_dirs，
    // 顺序反了会让新加的目录到下一次保存才生效
    const current = loadAppSettings()
    saveAppSettings({
      ...current,
      default_project_dir: patch.default_project_dir ?? current.default_project_dir,
      template_dirs: patch.template_dirs ?? current.template_dirs
    })
    // 模板目录变更即时生效：重建 TemplateManager 并替换服务引用
    service.setManager(buildTemplateManager().manager)
  })

  handle<void, StructureTemplateDto[]>(ProjectIpc.TemplatesListStructures, () =>
    service
      .getManager()
      .listStructures()
      .map((s) => {
        const style = service.getManager().styleForStructure(s)
        return {
          name: s.name,
          category: s.category,
          description: s.description,
          version: s.version,
          styleFileKey: style?.fileKey ?? ''
        }
      })
  )

  handle<void, StyleTemplateDto[]>(ProjectIpc.TemplatesListStyles, () =>
    service.getManager().listStyles().map((s) => ({
      name: s.name,
      version: s.version,
      description: s.description,
      fileKey: s.fileKey
    }))
  )

  handle<void, TemplateLoadReport>(ProjectIpc.TemplatesDiagnose, () => buildTemplateManager().report)

  handle<string, StyleCandidateDto[]>(ProjectIpc.TemplatesStyleCandidates, (structureName) => {
    const def = service.getManager().findStructureByName(structureName)
    if (!def) return []
    return service.getManager().styleCandidatesForStructure(def).map((c) => ({
      fileKey: c.fileKey,
      name: c.name,
      version: c.version,
      description: c.description,
      available: c.available,
      missingKeys: c.missingKeys,
      isDefault: c.isDefault
    }))
  })

  // ---------- 导出 ----------
  handle<ExportDocxInput, Awaited<ReturnType<ProjectService['exportDocx']>>>(
    ProjectIpc.ExportDocx,
    (input) => service.exportDocx(input)
  )
  handle<void, FigureCountsDto>(ProjectIpc.ExportFigureCounts, () => service.figureCounts())
}
