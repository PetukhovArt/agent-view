import { listSupportedTargets, connectToPage } from '../cdp/transport.js'
import type { RuntimeAdapter } from './types.js'
import { RuntimeType, type WindowInfo } from '../types.js'
import { TargetType, type PageSession } from '../cdp/types.js'
import type { AxTreeCache } from '../cdp/ax-cache.js'

/** URLs that Tauri/WebView2 exposes as CDP targets but aren't app windows */
const INTERNAL_URL_PATTERNS = [
  'about:blank',
  'devtools://',
  'chrome-extension://',
]

export function isAppTarget(target: { type: string; url: string; title: string }): boolean {
  if (target.type !== TargetType.Page) return false
  const url = target.url.toLowerCase()
  return !INTERNAL_URL_PATTERNS.some(pattern => url.startsWith(pattern))
}

export const tauriAdapter: RuntimeAdapter = {
  runtime: RuntimeType.Tauri,

  async discover(port: number): Promise<WindowInfo[]> {
    const targets = await listSupportedTargets(port)
    return targets
      .filter(isAppTarget)
      .map(t => ({ id: t.id, title: t.title, url: t.url, type: t.type }))
  },

  async connect(port: number, windowId: string, cache: AxTreeCache): Promise<PageSession> {
    const targets = await listSupportedTargets(port)
    const target = targets.find(t => t.id === windowId)
    if (!target) throw new Error(`Target not found: ${windowId}`)
    return connectToPage(port, target, cache)
  },
}
