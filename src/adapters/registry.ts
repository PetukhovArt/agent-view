import { RuntimeType } from '../types.js'
import type { RuntimeAdapter } from './types.js'
import { electronAdapter } from './electron.js'
import { browserAdapter } from './browser.js'
import { tauriAdapter } from './tauri.js'

const adapters: Record<RuntimeType, RuntimeAdapter> = {
  [RuntimeType.Electron]: electronAdapter,
  [RuntimeType.Browser]: browserAdapter,
  [RuntimeType.Tauri]: tauriAdapter,
}

export function getAdapter(runtime: RuntimeType): RuntimeAdapter {
  return adapters[runtime]
}
