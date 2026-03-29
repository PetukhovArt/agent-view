import type { RuntimeType, WebGLEngine } from '../types.js'

export type AgentViewConfig = {
  runtime: RuntimeType
  port: number
  launch: string
  webgl?: {
    engine: WebGLEngine
  }
  verify?: Record<string, { steps: string[] }>
}
