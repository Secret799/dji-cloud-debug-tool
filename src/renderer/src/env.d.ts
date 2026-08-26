/// <reference types="vite/client" />

import type { DjiDesktopApi } from '../../shared/contracts'

declare global {
  interface Window {
    djiApi: DjiDesktopApi
  }
}

export {}
