/**
 * preload — contextBridge 类型化桥，把主进程 IPC 暴露成 window.desktopApi。
 * 沙箱开启时这里只能 require electron，不做其它导入。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { AppInfo, DesktopApi } from '../shared/contract'
import { IPC } from '../shared/contract'
import { ProjectIpc } from '../shared/project'
import type {
  BlockAddInput,
  BlockIndexInput,
  BlockMoveInput,
  BlockUpdateInput,
  CreateProjectInput,
  ExportDocxInput,
  FileWriteBytesInput,
  HistoryJumpInput,
  ImageImportInput,
  NodeCopyInput,
  NodeDeleteInput,
  NodeDescriptionInput,
  NodeTitleInput,
  SavePathDialogOptions,
  TemplateCreateInput,
  TemplateDeleteInput,
  TemplateReadInput,
  TemplateRenameInput,
  TemplateSaveInput,
  UiStateKeyInput
} from '../shared/project'

const invoke = (channel: string, arg?: unknown): Promise<unknown> =>
  ipcRenderer.invoke(channel, arg)

const api: DesktopApi = {
  platform: process.platform as DesktopApi['platform'],
  getAppInfo: () => invoke(IPC.AppGetInfo) as Promise<AppInfo>,
  window: {
    minimize: () => ipcRenderer.send(IPC.WindowMinimize),
    toggleMaximize: () => ipcRenderer.send(IPC.WindowToggleMaximize),
    close: () => ipcRenderer.send(IPC.WindowClose),
    isMaximized: () => invoke(IPC.WindowIsMaximized) as Promise<boolean>,
    onMaximizedChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, maximized: boolean): void => {
        listener(maximized)
      }
      ipcRenderer.on(IPC.WindowMaximizedChanged, handler)
      return () => {
        ipcRenderer.removeListener(IPC.WindowMaximizedChanged, handler)
      }
    }
  },
  project: {
    create: (input: CreateProjectInput) =>
      invoke(ProjectIpc.ProjectCreate, input) as ReturnType<DesktopApi['project']['create']>,
    open: (dprojPath: string) =>
      invoke(ProjectIpc.ProjectOpen, dprojPath) as ReturnType<DesktopApi['project']['open']>,
    close: () => invoke(ProjectIpc.ProjectClose) as Promise<void>,
    save: () => invoke(ProjectIpc.ProjectSave) as ReturnType<DesktopApi['project']['save']>,
    isOpen: () => invoke(ProjectIpc.ProjectIsOpen) as Promise<boolean>,
    getInfo: () => invoke(ProjectIpc.ProjectGetInfo) as ReturnType<DesktopApi['project']['getInfo']>,
    treeGetRoot: () =>
      invoke(ProjectIpc.TreeGetRoot) as ReturnType<DesktopApi['project']['treeGetRoot']>,
    revealFolder: () =>
      invoke(ProjectIpc.ProjectRevealFolder) as ReturnType<DesktopApi['project']['revealFolder']>,
    pageTextWidth: () =>
      invoke(ProjectIpc.ProjectPageTextWidth) as ReturnType<DesktopApi['project']['pageTextWidth']>,
    precheck: () =>
      invoke(ProjectIpc.ProjectPrecheck) as ReturnType<DesktopApi['project']['precheck']>
  },
  tree: {
    updateTitle: (input: NodeTitleInput) =>
      invoke(ProjectIpc.NodeUpdateTitle, input) as Promise<void>,
    updateDescription: (input: NodeDescriptionInput) =>
      invoke(ProjectIpc.NodeUpdateDescription, input) as Promise<void>,
    copy: (input: NodeCopyInput) =>
      invoke(ProjectIpc.NodeCopy, input) as ReturnType<DesktopApi['tree']['copy']>,
    delete: (input: NodeDeleteInput) => invoke(ProjectIpc.NodeDelete, input) as Promise<void>
  },
  block: {
    add: (input: BlockAddInput) =>
      invoke(ProjectIpc.BlockAdd, input) as ReturnType<DesktopApi['block']['add']>,
    remove: (input: BlockIndexInput) =>
      invoke(ProjectIpc.BlockRemove, input) as ReturnType<DesktopApi['block']['remove']>,
    move: (input: BlockMoveInput) => invoke(ProjectIpc.BlockMove, input) as Promise<void>,
    update: (input: BlockUpdateInput) =>
      invoke(ProjectIpc.BlockUpdate, input) as Promise<void>,
    importImage: (input: ImageImportInput) =>
      invoke(ProjectIpc.ImageImport, input) as ReturnType<DesktopApi['block']['importImage']>,
    writeBytes: (input: FileWriteBytesInput) =>
      invoke(ProjectIpc.FileWriteBytes, input) as ReturnType<DesktopApi['block']['writeBytes']>
  },
  history: {
    undo: () => invoke(ProjectIpc.HistoryUndo) as ReturnType<DesktopApi['history']['undo']>,
    redo: () => invoke(ProjectIpc.HistoryRedo) as ReturnType<DesktopApi['history']['redo']>,
    state: () => invoke(ProjectIpc.HistoryState) as ReturnType<DesktopApi['history']['state']>,
    jump: (input: HistoryJumpInput) =>
      invoke(ProjectIpc.HistoryJump, input) as ReturnType<DesktopApi['history']['jump']>
  },
  uiState: {
    save: (key: string, value: string) =>
      invoke(ProjectIpc.UiStateSave, { key, value }) as Promise<void>,
    load: (key: string) =>
      invoke(ProjectIpc.UiStateLoad, { key } as UiStateKeyInput) as Promise<string>
  },
  dialog: {
    selectDproj: () =>
      invoke(ProjectIpc.DialogSelectDproj) as ReturnType<DesktopApi['dialog']['selectDproj']>,
    selectDirectory: () =>
      invoke(ProjectIpc.DialogSelectDirectory) as ReturnType<
        DesktopApi['dialog']['selectDirectory']
      >,
    selectImage: () =>
      invoke(ProjectIpc.DialogSelectImage) as ReturnType<DesktopApi['dialog']['selectImage']>,
    savePath: (options: SavePathDialogOptions) =>
      invoke(ProjectIpc.DialogSavePath, options) as ReturnType<DesktopApi['dialog']['savePath']>
  },
  export: {
    docx: (input: ExportDocxInput) =>
      invoke(ProjectIpc.ExportDocx, input) as ReturnType<DesktopApi['export']['docx']>,
    figureCounts: () =>
      invoke(ProjectIpc.ExportFigureCounts) as ReturnType<DesktopApi['export']['figureCounts']>
  },
  files: {
    readAsDataUrl: (relPath: string) =>
      invoke(ProjectIpc.FileReadDataUrl, relPath) as ReturnType<DesktopApi['files']['readAsDataUrl']>
  },
  settings: {
    get: () => invoke(ProjectIpc.SettingsGet) as ReturnType<DesktopApi['settings']['get']>,
    set: (patch) => invoke(ProjectIpc.SettingsSet, patch) as Promise<void>
  },
  templates: {
    listStructures: () =>
      invoke(ProjectIpc.TemplatesListStructures) as ReturnType<
        DesktopApi['templates']['listStructures']
      >,
    listStyles: () =>
      invoke(ProjectIpc.TemplatesListStyles) as ReturnType<DesktopApi['templates']['listStyles']>,
    styleCandidates: (structureName: string) =>
      invoke(ProjectIpc.TemplatesStyleCandidates, structureName) as ReturnType<
        DesktopApi['templates']['styleCandidates']
      >,
    diagnose: () =>
      invoke(ProjectIpc.TemplatesDiagnose) as ReturnType<DesktopApi['templates']['diagnose']>
  },
  templateEditor: {
    snapshot: () =>
      invoke(ProjectIpc.TemplateSnapshot) as ReturnType<
        DesktopApi['templateEditor']['snapshot']
      >,
    read: (input: TemplateReadInput) =>
      invoke(ProjectIpc.TemplateRead, input) as ReturnType<DesktopApi['templateEditor']['read']>,
    save: (input: TemplateSaveInput) =>
      invoke(ProjectIpc.TemplateSave, input) as ReturnType<DesktopApi['templateEditor']['save']>,
    create: (input: TemplateCreateInput) =>
      invoke(ProjectIpc.TemplateCreate, input) as ReturnType<
        DesktopApi['templateEditor']['create']
      >,
    remove: (input: TemplateDeleteInput) =>
      invoke(ProjectIpc.TemplateDelete, input) as ReturnType<
        DesktopApi['templateEditor']['remove']
      >,
    rename: (input: TemplateRenameInput) =>
      invoke(ProjectIpc.TemplateRename, input) as ReturnType<
        DesktopApi['templateEditor']['rename']
      >
  }
}

contextBridge.exposeInMainWorld('documentor', api)
