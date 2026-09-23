import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PageSession, Point } from '../cdp/types.js'
import type { ServerResponse } from '../types.js'
import {
  PASSWORD_MASK,
  describeControl,
  extractControls,
  formatControlRow,
  formatControlTable,
  resolveRow,
  type Control,
} from '../inspectors/controls/index.js'
import { findByLocator, locatorFromArgs, testIdAttributes, type Locator } from './locator.js'
import { TOKEN_DIR } from './port.js'
import { replay } from './act-replay.js'

const DEFAULT_MAX_STEPS = 30
const SETTLE_POLL_MS = 100
const SETTLE_BUDGET_MS = 3_000
/** Polls the table must stay unchanged, after it changed, to count as settled. */
const SETTLE_STABLE_POLLS = 2
/** Polls an action that changed nothing waits before giving up on a reaction. */
const SETTLE_QUIET_POLLS = 4
const TEXT_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])
const SCRATCH_DIR = join(TOKEN_DIR, 'scratch')

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

const stepTarget = (c: Control): StepTarget => ({ testid: c.testid, role: c.role, name: c.name })

/** Step-protocol state for one CDP port. Rows are those of the LAST printed table. */
export type ActSession = {
  until?: Locator
  untilArgs: UntilArgs
  maxSteps: number
  testIdAttributes: readonly string[]
  rows: Control[]
  steps: RecordedStep[]
  startedAt: number
  /** Script name to write on DONE (`act start --save`). */
  saveAs?: string
}

export const isDeadSocket = (err: unknown): boolean =>
  err instanceof Error && /WebSocket (is not open|connection closed)/.test(err.message)

/**
 * The action went out and the window reloaded under it (logout, login) — the socket
 * died, the step did not fail. The caller reconnects and settles on the new document.
 */
export class ReloadedAfterAction extends Error {
  constructor(readonly done: string) {
    super(`${done} — window reloaded`)
  }
}

export type ActDeps = {
  conn: PageSession
  invalidateAxCache: () => void
  /** Fresh session after the window reloaded under us. */
  reconnect: () => Promise<PageSession>
}

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' ? args[key] as string : undefined

export async function runAct(
  holder: { act: ActSession | null },
  args: Record<string, unknown>,
  deps: ActDeps,
): Promise<ServerResponse> {
  const op = str(args, 'op')
  if (op === 'replay') {
    const name = str(args, 'name')
    if (!isScriptName(name)) return { ok: false, error: 'act replay <name>' }
    return replay(name, str(args, 'secret'), testIdAttributes(str(args, 'testIdAttribute')), str(args, 'testIdAttribute'), deps)
  }
  if (op === 'start') {
    holder.act = createSession(args)
    return tableOrDone(holder.act, deps)
  }
  const session = holder.act
  if (!session) return { ok: false, error: 'run `agent-view act start` first' }

  if (op === 'table') return tableOrDone(session, deps)
  if (op === 'save') return saveReplay(session, str(args, 'name'))
  if (session.steps.length >= session.maxSteps) {
    return { ok: true, data: `BLOCKED: step budget ${session.maxSteps} exhausted\n${await printTable(session, deps)}` }
  }
  if (op === 'wait') {
    return finishStep(session, deps, tableKey(await snapshot(session, deps)), 'wait', Infinity)
  }
  if (op === 'scroll') return scrollStep(session, deps, str(args, 'direction'))
  if (op === 'drag') return dragStep(session, deps, typeof args.n === 'number' ? args.n : NaN, { to: str(args, 'to'), edge: str(args, 'edge'), testIdAttribute: str(args, 'testIdAttribute') })
  if (op === 'click' || op === 'type' || op === 'select') return rowStep(session, deps, op, args)
  if (op === 'do') return batchStep(session, deps, args.steps)
  return { ok: false, error: `Unknown act op: ${op}` }
}

function createSession(args: Record<string, unknown>): ActSession {
  const untilArgs: UntilArgs = { testid: str(args, 'untilTestid'), selector: str(args, 'untilSelector') }
  const testIdAttribute = str(args, 'testIdAttribute')
  const maxSteps = typeof args.maxSteps === 'number' && args.maxSteps > 0 ? args.maxSteps : DEFAULT_MAX_STEPS
  return {
    until: locatorFromArgs({ ...untilArgs, testIdAttribute }),
    untilArgs,
    maxSteps,
    testIdAttributes: testIdAttributes(testIdAttribute),
    rows: [],
    steps: [],
    startedAt: Date.now(),
    saveAs: str(args, 'save'),
  }
}

async function snapshot(session: ActSession, deps: ActDeps): Promise<Control[]> {
  deps.invalidateAxCache()
  const [ax, layout] = await Promise.all([deps.conn.getAccessibilityTree(), deps.conn.getLayoutSnapshot()])
  return extractControls(ax, layout, session.testIdAttributes)
}

/** Prints `controls` (or a fresh snapshot) and makes it the table the next `n` refers to. */
async function printTable(session: ActSession, deps: ActDeps, controls?: Control[]): Promise<string> {
  session.rows = controls ?? await snapshot(session, deps)
  return formatControlTable(session.rows, {
    step: session.steps.length,
    maxSteps: session.maxSteps,
    untilLabel: session.until?.label,
  })
}

async function rowStep(
  session: ActSession,
  deps: ActDeps,
  op: 'click' | 'type' | 'select',
  args: Record<string, unknown>,
): Promise<ServerResponse> {
  const n = typeof args.n === 'number' ? args.n : NaN
  const text = str(args, 'text') ?? ''
  const located = await locate(session, deps, n)
  if ('ok' in located) return located
  const { target, fresh } = located
  if (op === 'type' && !TEXT_ROLES.has(target.role)) {
    return { ok: false, error: `[${n}] is a ${target.role}, not a text field — pick a textbox/combobox row` }
  }

  const before = tableKey(fresh)
  const echo = op === 'click' ? '' : ` ${target.isPassword ? PASSWORD_MASK : JSON.stringify(text)}`
  const done = `${op} [${n}] ${describeControl(target)}${echo}`
  let isRecorded = false
  const record = () => {
    if (isRecorded) return
    isRecorded = true
    session.steps.push({
      op,
      target: stepTarget(target),
      value: op === 'click' ? undefined : text,
      isPassword: target.isPassword,
    })
  }
  try {
    if (op === 'click') {
      await deps.conn.clickByNodeId(target.backendDOMNodeId)
    } else if (op === 'type') {
      await deps.conn.fillByNodeId(target.backendDOMNodeId, text)
    } else {
      const outcome = await deps.conn.selectOption(target.backendDOMNodeId, text)
      if (outcome === 'not-select') return { ok: false, error: 'not a native select — click it' }
      if (outcome === 'no-option') return { ok: false, error: `No option "${text}" in [${n}]` }
    }
    deps.invalidateAxCache()
    record()
    return await finishStep(session, deps, before, done)
  } catch (err) {
    if (!isDeadSocket(err)) throw err
    record()
    throw new ReloadedAfterAction(done)
  }
}

/**
 * Several row ops decided from ONE table — a form fill is one decision, not three model
 * turns. Every n refers to that table: it is re-pinned before each op, so the stale guard
 * maps it onto whatever the previous op left. Stops at the first error, BLOCKED or DONE.
 */
async function batchStep(session: ActSession, deps: ActDeps, raw: unknown): Promise<ServerResponse> {
  const steps = Array.isArray(raw) ? raw.map(String) : []
  if (steps.length === 0) return { ok: false, error: 'act do "<op> <n> [text]" …' }
  const pinned = session.rows
  const lines: string[] = []
  let last: ServerResponse = { ok: false, error: 'no steps ran' }
  for (const step of steps) {
    const [op, n, ...rest] = step.trim().split(/\s+/)
    if (op !== 'click' && op !== 'type' && op !== 'select') {
      return { ok: false, error: `act do: "${step}" — only click / type / select` }
    }
    session.rows = pinned
    last = await rowStep(session, deps, op, { n: Number(n), text: rest.join(' ') })
    const text = last.ok ? String(last.data) : ''
    if (!last.ok || !text.startsWith('✓')) break
    lines.push(text.split('\n')[0])
  }
  if (!last.ok) return lines.length ? { ok: false, error: `${lines.join('\n')}\n${last.error}` } : last
  const tail = String(last.data)
  return { ok: true, data: tail.startsWith('✓') ? [...lines.slice(0, -1), tail].join('\n') : [...lines, tail].join('\n') }
}

/** Row n of the last table in a fresh snapshot: stale guard, then hit check. */
async function locate(
  session: ActSession,
  deps: ActDeps,
  n: number,
): Promise<{ target: Control; fresh: Control[] } | ServerResponse> {
  const last = session.rows[n - 1]
  if (!last) return { ok: false, error: `No row [${n}] in the last table (1-${session.rows.length})` }
  const fresh = await snapshot(session, deps)
  const resolved = resolveRow(last, fresh)
  if ('gone' in resolved) return blocked(`[${n}] ${describeControl(last)} is gone`, session, deps, fresh)
  const covering = await deps.conn.hitTest(resolved.control.backendDOMNodeId, session.testIdAttributes)
  if (covering) return blocked(`[${n}] covered by ${covering}`, session, deps, fresh)
  return { target: resolved.control, fresh }
}

export const EDGES = ['left', 'right', 'top', 'bottom', 'center'] as const
export type Edge = typeof EDGES[number]
/** Deepest a drop point sits inside an edge; split zones along a widget edge are ~60 px strips. */
const EDGE_INSET_PX = 20

type Box = { x: number; y: number; width: number; height: number }

/** Drop point inside `box`, on its midline, inset from `edge` — a centre drop replaces instead of splitting. */
export function edgePoint(box: Box, edge: Edge): Point {
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

export async function viewportBox(conn: PageSession): Promise<Box> {
  const { viewport } = await conn.getLayoutSnapshot()
  return { x: 0, y: 0, ...viewport }
}

const isEdge = (value: string): value is Edge => (EDGES as readonly string[]).includes(value)

/**
 * Pointer drag of row n onto an edge of: row `to`, any visible element `testid=<id>`
 * (drop zones are rarely controls), or the viewport.
 */
async function dragStep(
  session: ActSession,
  deps: ActDeps,
  n: number,
  { to, edge: rawEdge = 'center', testIdAttribute }: { to?: string; edge?: string; testIdAttribute?: string },
): Promise<ServerResponse> {
  if (!isEdge(rawEdge)) return { ok: false, error: `act drag <n> [to] [edge] — edge is one of ${EDGES.join('|')}` }
  const edge = rawEdge
  const located = await locate(session, deps, n)
  if ('ok' in located) return located
  const from = await deps.conn.getBoxCenter(located.target.backendDOMNodeId)
  let box: Box
  let toLabel: string
  let toTarget: DropTarget | undefined
  if (to === undefined || to === 'center') {
    box = await viewportBox(deps.conn)
    toLabel = 'viewport'
  } else if (to.startsWith('testid=')) {
    const testid = to.slice('testid='.length)
    const found = await findByLocator(deps.conn, locatorFromArgs({ testid, testIdAttribute })!)
    if ('error' in found) return { ok: false, error: found.error }
    box = await deps.conn.getBoxRect(found.backendDOMNodeId, { scrollIntoView: false })
    toLabel = to
    toTarget = { testid }
  } else {
    const dest = await locate(session, deps, Number(to))
    if ('ok' in dest) return dest
    box = await deps.conn.getBoxRect(dest.target.backendDOMNodeId, { scrollIntoView: false })
    toLabel = `[${to}] ${describeControl(dest.target)}`
    toTarget = stepTarget(dest.target)
  }
  const before = tableKey(located.fresh)
  await deps.conn.dragBetweenPositions(from, edgePoint(box, edge), { mode: 'pointer' })
  deps.invalidateAxCache()
  session.steps.push({ op: 'drag', target: stepTarget(located.target), to: toTarget, edge })
  const source = `${describeControl(located.target)}${located.target.testid ? ` testid=${located.target.testid}` : ''}`
  return finishStep(session, deps, before, `drag [${n}] ${source} → ${toLabel} ${edge}`)
}

async function scrollStep(session: ActSession, deps: ActDeps, direction: string | undefined): Promise<ServerResponse> {
  if (direction !== 'up' && direction !== 'down') return { ok: false, error: 'act scroll <up|down>' }
  const before = tableKey(await snapshot(session, deps))
  await deps.conn.scrollViewport(direction)
  deps.invalidateAxCache()
  session.steps.push({ op: 'scroll', direction })
  return finishStep(session, deps, before, `scroll ${direction}`)
}

async function blocked(reason: string, session: ActSession, deps: ActDeps, fresh: Control[]): Promise<ServerResponse> {
  return { ok: true, data: `BLOCKED: ${reason}\n${await printTable(session, deps, fresh)}` }
}

const tableKey = (controls: Control[]): string => controls.map((c, i) => formatControlRow(c, i)).join('\n')

/** A table the decider asked for still ends the run when the goal was reached meanwhile. */
async function tableOrDone(session: ActSession, deps: ActDeps): Promise<ServerResponse> {
  const table = await printTable(session, deps)
  return { ok: true, data: await isUntilMet(session, deps) ? await doneLine(session) : table }
}

/** The DONE line; with `start --save`, the recording is written here, sparing the decider a turn. */
async function doneLine(session: ActSession): Promise<string> {
  const line = `DONE: until ${session.until!.label} · ${session.steps.length} steps · ${((Date.now() - session.startedAt) / 1000).toFixed(1)}s`
  if (!session.saveAs) return line
  const saved = await saveReplay(session, session.saveAs)
  return `${line} · saved ${saved.ok ? saved.data : saved.error}`
}

async function isUntilMet(session: ActSession, deps: ActDeps): Promise<boolean> {
  if (!session.until) return false
  return !('error' in await findByLocator(deps.conn, session.until))
}

/**
 * Settle, not sleep: poll until the until-condition holds, or the table changed and then
 * held still for SETTLE_STABLE_POLLS polls, or never changed for SETTLE_QUIET_POLLS, or the
 * budget runs out.
 */
async function finishStep(
  session: ActSession,
  deps: ActDeps,
  before: string,
  done: string,
  quietPolls = SETTLE_QUIET_POLLS,
): Promise<ServerResponse> {
  const t0 = Date.now()
  let previous = before
  let hasChanged = false
  let stablePolls = 0
  let controls: Control[] = []
  let isDone = false
  do {
    await new Promise(r => setTimeout(r, SETTLE_POLL_MS))
    controls = await snapshot(session, deps)
    isDone = await isUntilMet(session, deps)
    if (isDone) break
    const key = tableKey(controls)
    // An empty table is a document between loads, never a settled screen.
    if (controls.length === 0) {
      hasChanged = true
      stablePolls = 0
    } else if (key !== previous) {
      hasChanged = true
      stablePolls = 0
    } else {
      stablePolls++
    }
    previous = key
  } while (stablePolls < (hasChanged ? SETTLE_STABLE_POLLS : quietPolls) && Date.now() - t0 < SETTLE_BUDGET_MS)
  const elapsed = Date.now() - t0

  const k = session.steps.length
  if (isDone) return { ok: true, data: await doneLine(session) }
  const table = await printTable(session, deps, controls)
  if (k >= session.maxSteps) return { ok: true, data: `BLOCKED: step budget ${session.maxSteps} exhausted\n${table}` }
  return { ok: true, data: `✓ ${done} · ${elapsed}ms\n${table}` }
}

export const isScriptName = (name: string | undefined): name is string => !!name && /^[\w.-]+$/.test(name)
export const scriptPath = (name: string): string => join(SCRATCH_DIR, `${name}.json`)

/** Steps are stored by what identifies a control across runs, never by row number. Passwords are not stored. */
async function saveReplay(session: ActSession, name: string | undefined): Promise<ServerResponse> {
  if (!isScriptName(name)) return { ok: false, error: 'act save <name> — letters, digits, . _ - only' }
  await mkdir(SCRATCH_DIR, { recursive: true })
  const steps = session.steps.map(s => ('isPassword' in s && s.isPassword ? { ...s, value: undefined } : s))
  const script: ActScript = { until: session.untilArgs, steps }
  await writeFile(scriptPath(name), JSON.stringify(script, null, 1))
  return { ok: true, data: `${scriptPath(name)} · replay: agent-view act replay ${name}` }
}
