/**
 * contract.ts — 主进程、预加载与渲染层共享的 IPC 契约与数据形状。
 * 三端引用同一份类型，避免通道名与 DTO 漂移。
 */

import type {
  DesktopBlockApi,
  DesktopDialogApi,
  DesktopExportApi,
  DesktopFileApi,
  DesktopHistoryApi,
  DesktopProjectApi,
  DesktopSettingsApi,
  DesktopTemplatesApi,
  DesktopTreeApi,
  DesktopUiStateApi
} from './project'

/**
 * Main ⇄ preload ⇄ renderer 共享的 IPC 契约与常量。
 */

export type DesktopPlatform = 'win32' | 'darwin' | 'linux'

export const IPC = {
  /** 调用返回应用信息 */
  AppGetInfo: 'app:get-info',
  /** 单向发送，不需要回执 */
  WindowMinimize: 'window:minimize',
  WindowToggleMaximize: 'window:toggle-maximize',
  WindowClose: 'window:close',
  /** 调用返回布尔值 */
  WindowIsMaximized: 'window:is-maximized',
  /** main → renderer 推送 */
  WindowMaximizedChanged: 'window:maximized-changed'
} as const

export interface AppInfo {
  version: string
  platform: DesktopPlatform
}

export interface WindowControlApi {
  minimize(): void
  toggleMaximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  /** 订阅最大化状态变化，返回取消订阅函数 */
  onMaximizedChange(listener: (maximized: boolean) => void): () => void
}

export interface DesktopApi {
  /** 平台（同步可用，来自进程环境） */
  platform: DesktopPlatform
  /** 应用信息（异步取回，主进程提供 version 等） */
  getAppInfo(): Promise<AppInfo>
  window: WindowControlApi
  project: DesktopProjectApi
  tree: DesktopTreeApi
  block: DesktopBlockApi
  history: DesktopHistoryApi
  uiState: DesktopUiStateApi
  dialog: DesktopDialogApi
  export: DesktopExportApi
  settings: DesktopSettingsApi
  templates: DesktopTemplatesApi
  files: DesktopFileApi
}
