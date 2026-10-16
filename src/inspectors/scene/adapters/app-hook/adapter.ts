import { WebGLEngine } from '../../../../types.js'
import type { SceneAdapter, SceneNode } from '../../types.js'
import { APP_HOOK_EXTRACT_SCRIPT, HOOK, appHookGotoScript, appHookLocateScript } from './injection.js'

const strings = (raw: unknown): Record<string, string> | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]))
}

function parseNode(raw: unknown): SceneNode | null {
  const n = raw as Record<string, unknown> | null
  if (typeof n?.type !== 'string' || typeof n.name !== 'string' || typeof n.visible !== 'boolean') return null
  const children = Array.isArray(n.children) ? parseNodes(n.children) : undefined
  if (children === null) return null
  const hasPoint = typeof n.x === 'number' && typeof n.y === 'number'
  return {
    type: n.type,
    name: n.name,
    ...(hasPoint ? { x: n.x as number, y: n.y as number } : {}),
    visible: n.visible,
    ...(children ? { children } : {}),
    ...(n.extras ? { extras: strings(n.extras) } : {}),
    ...(n.verboseExtras ? { verboseExtras: strings(n.verboseExtras) } : {}),
  }
}

function parseNodes(raw: unknown[]): SceneNode[] | null {
  const nodes = raw.map(parseNode)
  return nodes.every(node => node !== null) ? nodes as SceneNode[] : null
}

export const appHookAdapter: SceneAdapter = {
  engine: WebGLEngine.AppHook,
  extractScript: APP_HOOK_EXTRACT_SCRIPT,
  noScene: `No scene: window.${HOOK} is not on the page, or its nodes() returned no SceneNode[]`,
  normalize(raw: unknown): SceneNode | null {
    const children = Array.isArray(raw) ? parseNodes(raw) : null
    return children && { type: 'Scene', name: '', visible: true, children }
  },
  locateScript: appHookLocateScript,
  gotoScript: appHookGotoScript,
}
