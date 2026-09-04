/**
 * mmd2vsdx 模块声明（可选运行时依赖：桌面端安装，库端动态加载）。
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
