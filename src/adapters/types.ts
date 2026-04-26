import type { WindowInfo, RuntimeType } from '../types.js'
import type { PageSession } from '../cdp/types.js'
import type { AxTreeCache } from '../cdp/ax-cache.js'

export type RuntimeAdapter = {
  readonly runtime: RuntimeType
  /** Discover page-targets only — kept for back-compat. Use `listSupportedTargets` for all targets. */
  discover(port: number): Promise<WindowInfo[]>
  /** Connect to a page-target. Worker targets go through `connectToRuntime` directly. */
  connect(port: number, windowId: string, cache: AxTreeCache): Promise<PageSession>
}
