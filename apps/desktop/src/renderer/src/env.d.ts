/// <reference types="vite/client" />
import type { DesktopApi } from '../../shared/contract'

declare global {
  interface Window {
    documentor: DesktopApi
  }
}

export {}
