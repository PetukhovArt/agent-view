import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PageSession, Point, Rect } from '../cdp/types.js'
import { AGENT_VIEW_DIR } from './port.js'

/** How a replay finds a control again: its test id, else role + name. */
export type StepTarget = { testid?: string; role: string; name: string }

/** A drop target: a row, or any element by its test id. */
export type DropTarget = StepTarget | { testid: string }

export type RecordedStep =
  | { op: 'click' | 'type' | 'select'; target: StepTarget; value?: string; isPassword: boolean }
  | { op: 'scroll'; direction: 'up' | 'down' }
  /** `to`: a row, any element by test id, or absent = the viewport. */
  | { op: 'drag'; target: StepTarget; to?: DropTarget; edge: Edge }

export type UntilArgs = { testid?: string; selector?: string }

export type ActScript = { until: UntilArgs; steps: RecordedStep[] }

const SCRIPT_DIR = join(AGENT_VIEW_DIR, 'scratch')

export const isScriptName = (name: string | undefined): name is string => !!name && /^[\w.-]+$/.test(name)
const scriptPath = (name: string): string => join(SCRIPT_DIR, `${name}.json`)

/** Steps are stored by what identifies a control across runs, never by row number. Passwords are not stored. */
export async function writeScript(name: string, { until, steps }: ActScript): Promise<string> {
  await mkdir(SCRIPT_DIR, { recursive: true })
  const stored = steps.map(s => ('isPassword' in s && s.isPassword ? { ...s, value: undefined } : s))
  await writeFile(scriptPath(name), JSON.stringify({ until, steps: stored }, null, 1))
  return scriptPath(name)
}

export async function readScript(name: string): Promise<ActScript | undefined> {
  try {
    return JSON.parse(await readFile(scriptPath(name), 'utf8')) as ActScript
  } catch {
    return undefined
  }
}

export const EDGES = ['left', 'right', 'top', 'bottom', 'center'] as const
export type Edge = typeof EDGES[number]
/** Deepest a drop point sits inside an edge; split zones along a widget edge are ~60 px strips. */
const EDGE_INSET_PX = 20

export const isEdge = (value: string): value is Edge => (EDGES as readonly string[]).includes(value)

/** Drop point inside `box`, on its midline, inset from `edge` — a centre drop replaces instead of splitting. */
export function edgePoint(box: Rect, edge: Edge): Point {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const insetX = Math.min(EDGE_INSET_PX, box.width / 4)
  const insetY = Math.min(EDGE_INSET_PX, box.height / 4)
  if (edge === 'left') return { x: box.x + insetX, y: cy }
  if (edge === 'right') return { x: box.x + box.width - insetX, y: cy }
  if (edge === 'top') return { x: cx, y: box.y + insetY }
  if (edge === 'bottom') return { x: cx, y: box.y + box.height - insetY }
  return { x: cx, y: cy }
}

export async function viewportBox(conn: PageSession): Promise<Rect> {
  const { viewport } = await conn.getLayoutSnapshot()
  return { x: 0, y: 0, ...viewport }
}
