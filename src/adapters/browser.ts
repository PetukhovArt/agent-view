import { listSupportedTargets, connectToPage } from '../cdp/transport.js'
import type { RuntimeAdapter } from './types.js'
import { RuntimeType, type WindowInfo } from '../types.js'
import { type PageSession } from '../cdp/types.js'
import type { AxTreeCache } from '../cdp/ax-cache.js'
import { isAppTarget } from './target-filter.js'

export const browserAdapter: RuntimeAdapter = {
  runtime: RuntimeType.Browser,

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
