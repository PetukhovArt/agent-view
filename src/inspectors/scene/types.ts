import type { CDPConnection } from '../../cdp/types.js'
import type { WebGLEngine } from '../../types.js'

export type SceneNode = {
  type: string
  name: string
  x: number
  y: number
  visible: boolean
  tint: string
  alpha?: number
  scaleX?: number
  scaleY?: number
  rotation?: number
  width?: number
  height?: number
  children?: SceneNode[]
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

export type SceneExtractor = {
  readonly engine: WebGLEngine
  extract(conn: CDPConnection): Promise<SceneNode | null>
}
