import type { RuntimeSession } from '../../cdp/types.js'
import { WebGLEngine } from '../../types.js'
import { getRawScene } from '../scene/index.js'
import type { SceneBounds, SceneNode } from '../scene/types.js'
import { HOOK } from '../scene/adapters/app-hook/injection.js'
import { TOLERANCE_PX, bottom, contains, describeBox, hasArea, intersection, right } from './geometry.js'
import { SCENE_RULES, type AuditMiss, type AuditResult, type Finding, type SceneRule } from './types.js'
import { summarize } from './index.js'

const MIN_OVERLAP_PX = 2
const TEXT_TYPE = /text|label/i

type Placed = { node: SceneNode; path: string; parent: Placed | null; bounds: SceneBounds | undefined }

const isText = (n: SceneNode): boolean => TEXT_TYPE.test(n.type)

function flatten(root: SceneNode): Placed[] {
  const placed: Placed[] = []
  const byId = new Map<string, Placed>()
  const walk = (node: SceneNode, parent: Placed | null, path: string): void => {
    const here: Placed = { node, path, parent, bounds: node.bounds }
    placed.push(here)
    if (node.id !== undefined) byId.set(node.id, here)
    for (const child of node.children ?? []) walk(child, here, `${path} > ${label(child)}`)
  }
  for (const child of root.children ?? []) walk(child, null, label(child))
  for (const p of placed) {
    const named = p.node.parent === undefined ? undefined : byId.get(p.node.parent)
    if (named) p.parent = named
  }
  return placed
}

const label = (n: SceneNode): string => (n.name ? `${n.type} "${n.name}"` : n.type)

const shown = (p: Placed): boolean => {
  for (let at: Placed | null = p; at; at = at.parent) if (!at.node.visible) return false
  return true
}

function finding(p: Placed, rule: SceneRule, rect: SceneBounds, detail: string): Finding {
  const { node } = p
  return {
    rule,
    severity: 'error',
    target: { ...(node.id !== undefined ? { testid: node.id } : {}), role: node.type, ...(node.name ? { name: node.name } : {}), selector: p.path },
    rect,
    detail,
  }
}

export function hasBounds(root: SceneNode): boolean {
  return flatten(root).some(p => p.bounds)
}

export function runSceneRules(root: SceneNode, viewport: { width: number; height: number }, rules: readonly SceneRule[] = SCENE_RULES): Finding[] {
  const all = flatten(root)
  const texts = all.filter(p => isText(p.node) && p.bounds && hasArea(p.bounds) && shown(p))
  const findings: Finding[] = []

  if (rules.includes('scene-text-out')) {
    for (const t of texts) {
      const parent = t.parent?.bounds
      if (!parent || !t.parent || contains(parent, t.bounds!)) continue
      findings.push(finding(t, 'scene-text-out', t.bounds!, `text bounds ${describeBox(t.bounds!)} exceed its parent ${label(t.parent.node)} (${describeBox(parent)})`))
    }
  }

  if (rules.includes('scene-overlap')) {
    const groups = new Map<Placed | null, Placed[]>()
    for (const t of texts) groups.set(t.parent, [...(groups.get(t.parent) ?? []), t])
    for (const siblings of groups.values()) {
      for (let a = 0; a < siblings.length; a++) {
        for (let b = a + 1; b < siblings.length; b++) {
          const common = intersection(siblings[a].bounds!, siblings[b].bounds!)
          if (!common || common.width <= MIN_OVERLAP_PX || common.height <= MIN_OVERLAP_PX) continue
          findings.push(finding(siblings[a], 'scene-overlap', common, `intersects ${label(siblings[b].node)} (${describeBox(siblings[b].bounds!)}) by ${Math.round(common.width)}x${Math.round(common.height)} px`))
        }
      }
    }
  }

  if (rules.includes('scene-offscreen')) {
    for (const t of texts) {
      const rect = t.bounds!
      const overRight = right(rect) - viewport.width
      const overBottom = bottom(rect) - viewport.height
      const crosses = (overRight > TOLERANCE_PX && rect.x < viewport.width - TOLERANCE_PX)
        || (-rect.x > TOLERANCE_PX && right(rect) > TOLERANCE_PX)
        || (overBottom > TOLERANCE_PX && rect.y < viewport.height - TOLERANCE_PX)
        || (-rect.y > TOLERANCE_PX && bottom(rect) > TOLERANCE_PX)
      if (crosses) findings.push(finding(t, 'scene-offscreen', rect, `text bounds ${describeBox(rect)} cross the ${viewport.width}x${viewport.height} viewport edge`))
    }
  }

  return findings
}

const VIEWPORT_SCRIPT = `({
  width: document.documentElement.clientWidth,
  height: document.documentElement.clientHeight,
  coarse: window.matchMedia('(pointer: coarse)').matches
})`

export const NO_BOUNDS = `This scene gives no bounds: expose a bounds { x, y, width, height } in page CSS px on its nodes through window.${HOOK}.nodes() (engine "app-hook")`

export async function auditScene(conn: RuntimeSession, engine: WebGLEngine | undefined, rules: readonly SceneRule[] | undefined): Promise<AuditResult | AuditMiss> {
  if (engine !== WebGLEngine.AppHook) {
    return { error: `This engine gives no bounds: "audit --scene" needs "webgl": { "engine": "app-hook" } and a scene hook whose nodes carry bounds (window.${HOOK}); got ${engine ?? 'no engine'}` }
  }
  const root = await getRawScene(conn, engine)
  if (!root) return { error: `No scene: window.${HOOK} is not on the page, or its nodes() returned no SceneNode[]` }
  if (!hasBounds(root)) return { error: NO_BOUNDS }
  const view = await conn.evaluate(VIEWPORT_SCRIPT) as { width: number; height: number; coarse: boolean }
  return summarize(runSceneRules(root, view, rules), {
    viewport: { width: view.width, height: view.height },
    coarsePointer: view.coarse,
    scanned: flatten(root).length,
    truncated: false,
  })
}
