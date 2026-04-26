import { getExtractor } from './registry.js'
import { formatNode, diffScenes } from './formatter.js'
import type { RuntimeSession } from '../../cdp/types.js'
import type { WebGLEngine } from '../../types.js'
import type { SceneOptions, SceneNode } from './types.js'

export async function getSceneGraph(
  conn: RuntimeSession,
  engine: WebGLEngine | undefined,
  options: SceneOptions = {},
): Promise<string> {
  if (!engine) {
    return 'No WebGL engine configured. Add "webgl": { "engine": "pixi" } to agent-view.config.json'
  }
  const extractor = getExtractor(engine)
  const tree = await extractor.extract(conn)
  if (!tree) {
    return `No ${engine} scene found`
  }
  const lines: string[] = []
  formatNode(tree, 0, lines, options)
  if (lines.length === 0 && options.filter) {
    return `No scene objects matching "${options.filter}"`
  }
  return lines.join('\n')
}

export async function getRawScene(
  conn: RuntimeSession,
  engine: WebGLEngine | undefined,
): Promise<SceneNode | null> {
  if (!engine) return null
  const extractor = getExtractor(engine)
  return extractor.extract(conn)
}

export { diffScenes } from './formatter.js'
export type { SceneNode, SceneOptions } from './types.js'
