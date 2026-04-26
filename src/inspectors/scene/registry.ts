import { WebGLEngine } from '../../types.js'
import type { SceneAdapter } from './types.js'
import { pixiAdapter } from './adapters/pixi/index.js'

const adapters: Partial<Record<WebGLEngine, SceneAdapter>> = {
  [WebGLEngine.Pixi]: pixiAdapter,
}

export function getAdapter(engine: WebGLEngine): SceneAdapter {
  const adapter = adapters[engine]
  if (!adapter) {
    throw new Error(`Scene adapter for "${engine}" is not implemented yet`)
  }
  return adapter
}
