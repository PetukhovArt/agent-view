import { WebGLEngine } from '../../../../types.js'
import type { SceneAdapter, SceneNode } from '../../types.js'
import { PIXI_EXTRACT_SCRIPT, type RawPixiNode } from './injection.js'

const TINT_WHITE = 0xffffff

function isRawPixiNode(value: unknown): value is RawPixiNode {
  if (!value || typeof value !== 'object') return false
  const n = value as Record<string, unknown>
  return typeof n.type === 'string' && typeof n.name === 'string' && Array.isArray(n.children)
}

function tintToHex(tint: number): string {
  return '#' + tint.toString(16).padStart(6, '0')
}

function radToDegRounded(rad: number): number {
  return Math.round((rad * 180) / Math.PI * 100) / 100
}

function convert(raw: RawPixiNode): SceneNode {
  const extras: Record<string, string> = {}
  const verboseExtras: Record<string, string> = {}

  if (raw.tint !== null && raw.tint !== TINT_WHITE) {
    extras.tint = tintToHex(raw.tint)
  }
  if (raw.alpha !== 1) verboseExtras.alpha = String(raw.alpha)
  if (raw.scaleX !== 1 || raw.scaleY !== 1) verboseExtras.scale = `(${raw.scaleX},${raw.scaleY})`
  const rotDeg = radToDegRounded(raw.rotationRad)
  if (rotDeg !== 0) verboseExtras.rot = `${rotDeg}°`
  if (raw.width !== 0 || raw.height !== 0) verboseExtras.size = `${raw.width}x${raw.height}`

  return {
    type: raw.type,
    name: raw.name,
    x: raw.x,
    y: raw.y,
    visible: raw.visible,
    extras: Object.keys(extras).length > 0 ? extras : undefined,
    verboseExtras: Object.keys(verboseExtras).length > 0 ? verboseExtras : undefined,
    children: raw.children.length > 0 ? raw.children.map(convert) : undefined,
  }
}

export const pixiAdapter: SceneAdapter = {
  engine: WebGLEngine.Pixi,
  extractScript: PIXI_EXTRACT_SCRIPT,
  normalize(raw: unknown): SceneNode | null {
    if (!isRawPixiNode(raw)) return null
    return convert(raw)
  },
}
