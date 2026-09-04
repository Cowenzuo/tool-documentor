/**
 * mmd2vsdx 模块声明（桌面端与 packages/docx 的声明同构；上游为 ESM 库，主进程动态 import）。
 * 仅声明使用到的 API 子集，与上游 dist/app/application.d.ts 对齐。
 */
declare module 'mmd2vsdx' {
  export interface MmdConvertResult {
    ok: boolean
    error: string
    vsdxBase64: string
    diagramType: string
    pageCount: number
    /** 可选预览附带物（上游约定：previewBase64 + previewExt；提供则 docx 嵌入 v:imagedata） */
    previewBase64?: string
    previewExt?: 'png' | 'emf'
  }
  export interface MmdCreateOptions {
    outputScale?: number
    marginLeft?: number
    marginRight?: number
    marginTop?: number
    marginBottom?: number
    /** false = 零资产纯本地几何（无需 Visio/官方模具） */
    useConnectorMaster?: boolean
    diagramType?: string
  }
  export interface MmdStencilConfig {
    assetFile?: string
    stencilDir?: string
    search?: boolean
    cacheDir?: string
  }
  export const application: {
    configureStencils(config?: MmdStencilConfig): Promise<string>
    convertText(text: string, options?: MmdCreateOptions): Promise<MmdConvertResult>
    shutdown(): Promise<void>
  }
}
