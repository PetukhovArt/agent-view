import type { WindowInfo, RuntimeType } from '../types.js'
import type { CDPConnection } from '../cdp/types.js'
import type { AxTreeCache } from '../cdp/ax-cache.js'

export type RuntimeAdapter = {
  readonly runtime: RuntimeType
  discover(port: number): Promise<WindowInfo[]>
  connect(port: number, windowId: string, cache: AxTreeCache): Promise<CDPConnection>
}
