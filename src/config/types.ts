import type { RuntimeType, WebGLEngine } from '../types.js'
import type { TargetType } from '../cdp/types.js'

export type AgentViewConfig = {
  runtime: RuntimeType
  port: number
  launch: string
  webgl?: {
    engine: WebGLEngine
  }
  /**
   * When true, the server accepts `agent-view eval`. When false or missing, eval is refused.
   * Token-protected local socket already authenticates callers; this flag is the project-owner
   * opt-in for arbitrary JS execution against running targets.
   */
  allowEval?: boolean
  /** Per-target console ring capacity. Default 500. */
  consoleBufferSize?: number
  /** Target types that `agent-view console` auto-attaches to on first call. */
  consoleTargets?: ReadonlyArray<TargetType>
}
