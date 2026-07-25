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
  /**
   * When true, `agent-view network` captures response bodies (fetched eagerly at `loadingFinished`)
   * and request payloads. When false or missing, only metadata + headers are kept. Project-owner
   * opt-in — bodies may carry tokens/PII. WebSocket frame payloads are visible regardless.
   */
  captureBody?: boolean
  /** Per-target network ring capacity. Default 200 (smaller than console — entries are heavier). */
  networkBufferSize?: number
  /** Feed file for `agent-view logs`. Relative paths resolve against the project root. Default `.agent-view/console.log`. */
  logFile?: string
  /** Feed size cap in bytes. On overflow the feed rotates once to `<file>.prev`. Default 8 MB. */
  logMaxBytes?: number
}
