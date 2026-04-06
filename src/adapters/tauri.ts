import { listTargets, connectToTarget } from '../cdp/transport.js'
import type { RuntimeAdapter } from './types.js'
import { RuntimeType, type WindowInfo } from '../types.js'
import type { CDPConnection } from '../cdp/types.js'

/** URLs that Tauri/WebView2 exposes as CDP targets but aren't app windows */
const INTERNAL_URL_PATTERNS = [
  'about:blank',
  'devtools://',
  'chrome-extension://',
]

export function isAppTarget(target: { type: string; url: string; title: string }): boolean {
  if (target.type !== 'page') return false
  const url = target.url.toLowerCase()
  return !INTERNAL_URL_PATTERNS.some(pattern => url.startsWith(pattern))
}

export const tauriAdapter: RuntimeAdapter = {
  runtime: RuntimeType.Tauri,

  async discover(port: number): Promise<WindowInfo[]> {
    const targets = await listTargets(port)
    return targets
      .filter(isAppTarget)
      .map(t => ({
        id: t.id,
        title: t.title,
        url: t.url,
        type: t.type,
      }))
  },

  async connect(port: number, windowId: string): Promise<CDPConnection> {
    return connectToTarget(port, windowId)
  },
}
