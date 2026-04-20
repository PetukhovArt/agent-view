import { listTargets, connectToTarget } from '../cdp/transport.js'
import type { RuntimeAdapter } from './types.js'
import { RuntimeType, type WindowInfo } from '../types.js'
import type { CDPConnection } from '../cdp/types.js'
import type { AxTreeCache } from '../cdp/ax-cache.js'

export const browserAdapter: RuntimeAdapter = {
  runtime: RuntimeType.Browser,

  async discover(port: number): Promise<WindowInfo[]> {
    const targets = await listTargets(port)
    return targets
      .filter(t => t.type === 'page')
      .map(t => ({
        id: t.id,
        title: t.title,
        url: t.url,
        type: t.type,
      }))
  },

  async connect(port: number, windowId: string, cache: AxTreeCache): Promise<CDPConnection> {
    return connectToTarget(port, windowId, cache)
  },
}
