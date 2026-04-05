import { WebGLEngine } from '../../types.js'
import type { SceneExtractor } from './types.js'
import { pixiExtractor } from './pixi.js'

const extractors: Partial<Record<WebGLEngine, SceneExtractor>> = {
  [WebGLEngine.Pixi]: pixiExtractor,
}

export function getExtractor(engine: WebGLEngine): SceneExtractor {
  const extractor = extractors[engine]
  if (!extractor) {
    throw new Error(`Scene extractor for "${engine}" is not implemented yet`)
  }
  return extractor
}
