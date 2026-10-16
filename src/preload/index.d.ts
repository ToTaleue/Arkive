import { ElectronAPI } from '@electron-toolkit/preload'
import type { ArkiveApi } from '../shared/contracts/agent'

declare global {
  interface Window {
    electron: ElectronAPI
    api?: ArkiveApi
  }
}
