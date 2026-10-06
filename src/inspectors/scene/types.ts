import type { RuntimeSession } from '../../cdp/types.js'
import type { WebGLEngine } from '../../types.js'

export type SceneNode = {
  type: string
  name: string
  /** Page px; absent for a node with no spot on screen (a map entity behind the globe). */
  x?: number
  y?: number
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
  compact?: boolean
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
  /** Script resolving to the page point `{ x, y }` of the object `query` names, or `{ error }`. */
  locateScript?(query: string): string
  /** Script moving the camera over `target`, resolving to `{ lonLat: [lon, lat, height] }` or `{ error }`. */
  gotoScript?(target: SceneGoto): string
}

/** Where `scene --goto` points the camera: degrees and metres, or a scene object by id or name. */
export type SceneGoto = { lon: number; lat: number; height?: number } | { query: string }
