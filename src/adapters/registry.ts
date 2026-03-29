import type { RuntimeType } from '../types.js'
import type { RuntimeAdapter } from './types.js'
import { electronAdapter } from './electron.js'
import { browserAdapter } from './browser.js'
import { tauriAdapter } from './tauri.js'

const adapters: Record<RuntimeType, RuntimeAdapter> = {
  electron: electronAdapter,
  browser: browserAdapter,
  tauri: tauriAdapter,
}

export function getAdapter(runtime: RuntimeType): RuntimeAdapter {
  return adapters[runtime]
}
