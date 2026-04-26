import type { RuntimeSession } from '../../cdp/types.js'
import type { WebGLEngine } from '../../types.js'

export type SceneNode = {
  type: string
  name: string
  x: number
  y: number
  visible: boolean
  children?: SceneNode[]
  // Always shown inline (e.g. Pixi tint). Pre-formatted by the adapter.
  extras?: Record<string, string>
  // Shown only with --verbose (e.g. alpha, scale, rotation).
  verboseExtras?: Record<string, string>
}

export type SceneOptions = {
  filter?: string
  depth?: number
  verbose?: boolean
}

export type SceneDiffResult = {
  text: string
  snapshot: SceneNode
}

export type SceneAdapter = {
  readonly engine: WebGLEngine
  readonly extractScript: string
  // Returns null when the engine isn't present in the page.
  normalize(raw: unknown): SceneNode | null
}
