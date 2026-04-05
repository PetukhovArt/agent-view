import { WebGLEngine } from '../../types.js'
import type { CDPConnection } from '../../cdp/types.js'
import type { SceneExtractor, SceneNode } from './types.js'

// Depth limit is also enforced in JS to guard against stack overflow
// in the target process for pathologically deep trees
const EXTRACT_JS = `
(function() {
  const devtools = window.__PIXI_DEVTOOLS__;
  if (!devtools) return null;
  const app = devtools.app || devtools.stage?.parent;
  if (!app) return null;
  const stage = app.stage || devtools.stage;
  if (!stage) return null;

  function serialize(node, depth) {
    if (depth > 100) return null;
    const result = {
      type: node.constructor?.name || 'Unknown',
      name: node.label || node.name || '',
      x: Math.round(node.x || 0),
      y: Math.round(node.y || 0),
      visible: node.visible !== false,
      tint: typeof node.tint === 'number' ? '#' + node.tint.toString(16).padStart(6, '0') : '0xffffff',
      alpha: node.alpha ?? 1,
      scaleX: node.scale?.x ?? 1,
      scaleY: node.scale?.y ?? 1,
      rotation: Math.round((node.rotation || 0) * 180 / Math.PI * 100) / 100,
      width: Math.round(node.width || 0),
      height: Math.round(node.height || 0),
    };
    const kids = node.children || [];
    if (kids.length > 0) {
      result.children = kids.map(c => serialize(c, depth + 1)).filter(Boolean);
    }
    return result;
  }

  return serialize(stage, 0);
})()
`

function isSceneNode(val: unknown): val is SceneNode {
  if (!val || typeof val !== 'object') return false
  const n = val as Record<string, unknown>
  return typeof n.type === 'string' && typeof n.name === 'string'
}

export const pixiExtractor: SceneExtractor = {
  engine: WebGLEngine.Pixi,
  async extract(conn: CDPConnection): Promise<SceneNode | null> {
    const result = await conn.evaluate(EXTRACT_JS)
    return isSceneNode(result) ? result : null
  },
}
