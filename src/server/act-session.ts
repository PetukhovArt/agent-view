import type { Rect } from '../cdp/types.js'
import { isDeadSocket } from '../cdp/transport.js'
import type { ServerResponse } from '../types.js'
import {
  PASSWORD_MASK,
  TEXT_ROLES,
  describeControl,
  extractControls,
  formatControlRow,
  formatControlTable,
  resolveRow,
  type Control,
} from '../inspectors/controls/index.js'
import { findByLocator, locatorFromArgs, testIdAttributes, testIdLocator, type Locator } from './locator.js'
import {
  EDGES,
  edgePoint,
  isEdge,
  isScriptName,
  viewportBox,
  writeScript,
  type DropTarget,
  type RecordedStep,
  type StepTarget,
  type UntilArgs,
} from './act-script.js'
import { replay, type ActDeps } from './act-replay.js'

const DEFAULT_MAX_STEPS = 30
const SETTLE_POLL_MS = 100
const SETTLE_BUDGET_MS = 3_000
/** Polls the table must stay unchanged, after it changed, to count as settled. */
const SETTLE_STABLE_POLLS = 2
/** Polls an action that changed nothing waits before giving up on a reaction. */
const SETTLE_QUIET_POLLS = 4
const ROW_OPS = ['click', 'type', 'select'] as const
type RowOp = typeof ROW_OPS[number]
type RowStepArgs = { op: RowOp; n: number; text: string }

const stepTarget = (c: Control): StepTarget => ({ testid: c.testid, role: c.role, name: c.name })

/** Step-protocol state for one CDP port. Rows are those of the LAST printed table. */
export type ActSession = {
  until: Locator
  untilArgs: UntilArgs
  maxSteps: number
  testIdAttribute?: string
  rows: Control[]
  steps: RecordedStep[]
  startedAt: number
  /** Script name to write on DONE (`act start --save`). */
  saveAs?: string
}

/** One act call: the port's session and this request's handles on the server. */
type Run = { session: ActSession; deps: ActDeps }

const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' ? args[key] as string : undefined
const num = (value: unknown): number => (typeof value === 'number' ? value : NaN)
const isRowOp = (op: string): op is RowOp => (ROW_OPS as readonly string[]).includes(op)

export async function runAct(
  holder: { act: ActSession | null },
  args: Record<string, unknown>,
  deps: ActDeps,
): Promise<ServerResponse> {
  const op = str(args, 'op') ?? ''
  if (op === 'replay') {
    const name = str(args, 'name')
    if (!isScriptName(name)) return { ok: false, error: 'act replay <name>' }
    return replay({ name, secret: str(args, 'secret'), testIdAttribute: str(args, 'testIdAttribute') }, deps)
  }
  if (op === 'start') {
    // Done is agent-view's call, never the driver's: no run without a done condition.
    if ((str(args, 'untilTestid') === undefined) === (str(args, 'untilSelector') === undefined)) {
      return { ok: false, error: 'act start --until-testid <id> | --until-selector <css> — exactly one' }
    }
    holder.act = createSession(args)
    return tableOrDone({ session: holder.act, deps })
  }
  const session = holder.act
  if (!session) return { ok: false, error: 'run `agent-view act start` first' }
  const run: Run = { session, deps }

  if (op === 'table') return tableOrDone(run)
  if (op === 'save') return save(session, str(args, 'name'))
  if (op === 'wait') return finishStep(run, { before: tableKey(await snapshot(run)), done: 'wait', quietPolls: Infinity })
  if (session.steps.length >= session.maxSteps) {
    return { ok: true, data: `BLOCKED: step budget ${session.maxSteps} exhausted\n${await printTable(run)}` }
  }
  if (op === 'scroll') return scrollStep(run, str(args, 'direction'))
  if (op === 'drag') return dragStep(run, { n: num(args.n), to: str(args, 'to'), edge: str(args, 'edge') })
  if (isRowOp(op)) return rowStep(run, { op, n: num(args.n), text: str(args, 'text') ?? '' })
  if (op === 'do') return batchStep(run, args.steps)
  return { ok: false, error: `Unknown act op: ${op}` }
}

function createSession(args: Record<string, unknown>): ActSession {
  const untilArgs: UntilArgs = { testid: str(args, 'untilTestid'), selector: str(args, 'untilSelector') }
  const testIdAttribute = str(args, 'testIdAttribute')
  const maxSteps = typeof args.maxSteps === 'number' && args.maxSteps > 0 ? args.maxSteps : DEFAULT_MAX_STEPS
  return {
    until: locatorFromArgs({ ...untilArgs, testIdAttribute })!,
    untilArgs,
    maxSteps,
    testIdAttribute,
    rows: [],
    steps: [],
    startedAt: Date.now(),
    saveAs: str(args, 'save'),
  }
}

/** `read` on the live socket; when the window reloaded under it, once more on a fresh one. */
async function onLiveConn<T>(deps: ActDeps, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (err) {
    if (!isDeadSocket(err)) throw err
    deps.conn = await deps.reconnect()
    return read()
  }
}

const unlessDeadSocket = <T>(read: Promise<T>, fallback: T): Promise<T> => read.catch((err: unknown) => {
  if (isDeadSocket(err)) return fallback
  throw err
})

async function snapshot({ session, deps }: Run): Promise<Control[]> {
  deps.invalidateAxCache()
  return onLiveConn(deps, async () => {
    const [ax, layout] = await Promise.all([deps.conn.getAccessibilityTree(), deps.conn.getLayoutSnapshot()])
    return extractControls(ax, layout, testIdAttributes(session.testIdAttribute))
  })
}

/** Prints `controls` (or a fresh snapshot) and makes it the table the next `n` refers to. */
async function printTable(run: Run, controls?: Control[]): Promise<string> {
  const { session } = run
  session.rows = controls ?? await snapshot(run)
  return formatControlTable(session.rows, { step: session.steps.length, maxSteps: session.maxSteps, untilLabel: session.until.label })
}

async function rowStep(run: Run, { op, n, text }: RowStepArgs): Promise<ServerResponse> {
  const located = await locate(run, n)
  if (!('target' in located)) return located
  const { target, fresh } = located
  if (op === 'type' && !TEXT_ROLES.has(target.role)) {
    return { ok: false, error: `[${n}] is a ${target.role}, not a text field — pick a textbox/combobox row` }
  }

  const { session, deps } = run
  const echo = op === 'click' ? '' : ` ${target.isPassword ? PASSWORD_MASK : JSON.stringify(text)}`
  const done = `${op} [${n}] ${describeControl(target)}${echo}`
  let isReloaded = false
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
  } catch (err) {
    // The window reloaded under the action (login, logout): the socket died, the action went out.
    if (!isDeadSocket(err)) throw err
    isReloaded = true
  }
  deps.invalidateAxCache()
  session.steps.push({ op, target: stepTarget(target), value: op === 'click' ? undefined : text, isPassword: target.isPassword })
  return finishStep(run, { before: tableKey(fresh), done: isReloaded ? `${done} · window reloaded` : done })
}

/** `type 3 a  b` types `a  b`: the text is the rest of the step, spaces kept. */
function parseRowStep(step: string): RowStepArgs | undefined {
  const m = /^\s*(\S+)\s+(\d+)(?:\s(.*))?$/s.exec(step)
  return m && isRowOp(m[1]) ? { op: m[1], n: Number(m[2]), text: m[3] ?? '' } : undefined
}

/**
 * Several row ops decided from ONE table — a form fill is one decision, not three model
 * turns. Every n refers to that table: it is re-pinned before each op, so the stale guard
 * maps it onto whatever the previous op left. Stops at the first error, BLOCKED or DONE.
 */
async function batchStep(run: Run, raw: unknown): Promise<ServerResponse> {
  const steps = Array.isArray(raw) ? raw.map(String) : []
  const parsed = steps.map(parseRowStep)
  if (!parsed.every((p): p is RowStepArgs => p !== undefined)) {
    const bad = steps[parsed.indexOf(undefined)]
    return { ok: false, error: `act do: "${bad}" — each step is click|type|select <n> [text]` }
  }
  const pinned = run.session.rows
  const lines: string[] = []
  for (const [i, step] of parsed.entries()) {
    run.session.rows = pinned
    const result = await rowStep(run, step)
    if (!result.ok) return { ok: false, error: [...lines, result.error].join('\n') }
    const out = String(result.data)
    if (i === parsed.length - 1 || !out.startsWith('✓')) return { ok: true, data: [...lines, out].join('\n') }
    lines.push(out.split('\n')[0])
  }
  return { ok: false, error: 'act do "<op> <n> [text]" …' }
}

/** Row n of the last table in a fresh snapshot: stale guard, then hit check. */
async function locate(run: Run, n: number): Promise<{ target: Control; fresh: Control[] } | ServerResponse> {
  const { session, deps } = run
  const last = session.rows[n - 1]
  if (!last) return { ok: false, error: `No row [${n}] in the last table (1-${session.rows.length})` }
  const fresh = await snapshot(run)
  const resolved = resolveRow(last, fresh)
  if ('gone' in resolved) return blocked(run, `[${n}] ${describeControl(last)} is gone`, fresh)
  const covering = await deps.conn.hitTest(resolved.control.backendDOMNodeId, testIdAttributes(session.testIdAttribute))
  if (covering) return blocked(run, `[${n}] covered by ${covering}`, fresh)
  return { target: resolved.control, fresh }
}

/**
 * Pointer drag of row n onto an edge of: row `to`, any visible element `testid=<id>`
 * (drop zones are rarely controls), or the viewport.
 */
async function dragStep(
  run: Run,
  { n, to, edge = 'center' }: { n: number; to?: string; edge?: string },
): Promise<ServerResponse> {
  if (!isEdge(edge)) return { ok: false, error: `act drag <n> [to] [edge] — edge is one of ${EDGES.join('|')}` }
  const { session, deps } = run
  const located = await locate(run, n)
  if (!('target' in located)) return located
  let destId: number | undefined
  let toLabel = 'viewport'
  let toTarget: DropTarget | undefined
  if (to !== undefined && to !== 'center' && to.startsWith('testid=')) {
    const testid = to.slice('testid='.length)
    const found = await findByLocator(deps.conn, testIdLocator(testid, session.testIdAttribute))
    if ('error' in found) return { ok: false, error: found.error }
    destId = found.backendDOMNodeId
    toLabel = to
    toTarget = { testid }
  } else if (to !== undefined && to !== 'center') {
    const dest = await locate(run, Number(to))
    if (!('target' in dest)) return dest
    destId = dest.target.backendDOMNodeId
    toLabel = `[${to}] ${describeControl(dest.target)}`
    toTarget = stepTarget(dest.target)
  }
  // Source first: scrolling it into view may move the target, so the target is measured after.
  const from = await deps.conn.getBoxCenter(located.target.backendDOMNodeId)
  const box: Rect = destId === undefined ? await viewportBox(deps.conn) : await deps.conn.getBoxRect(destId, { scrollIntoView: false })
  await deps.conn.dragBetweenPositions(from, edgePoint(box, edge), { mode: 'pointer' })
  deps.invalidateAxCache()
  session.steps.push({ op: 'drag', target: stepTarget(located.target), to: toTarget, edge })
  const source = `${describeControl(located.target)}${located.target.testid ? ` testid=${located.target.testid}` : ''}`
  return finishStep(run, { before: tableKey(located.fresh), done: `drag [${n}] ${source} → ${toLabel} ${edge}` })
}

async function scrollStep(run: Run, direction: string | undefined): Promise<ServerResponse> {
  if (direction !== 'up' && direction !== 'down') return { ok: false, error: 'act scroll <up|down>' }
  const before = tableKey(await snapshot(run))
  await run.deps.conn.scrollViewport(direction)
  run.deps.invalidateAxCache()
  run.session.steps.push({ op: 'scroll', direction })
  return finishStep(run, { before, done: `scroll ${direction}` })
}

async function blocked(run: Run, reason: string, fresh: Control[]): Promise<ServerResponse> {
  return { ok: true, data: `BLOCKED: ${reason}\n${await printTable(run, fresh)}` }
}

const tableKey = (controls: Control[]): string => controls.map((c, i) => formatControlRow(c, i)).join('\n')

/** A table the decider asked for still ends the run when the goal was reached meanwhile. */
async function tableOrDone(run: Run): Promise<ServerResponse> {
  const table = await printTable(run)
  return { ok: true, data: await isUntilMet(run) ? await doneLine(run.session) : table }
}

/** The DONE line; with `start --save`, the recording is written here, sparing the decider a turn. */
async function doneLine(session: ActSession): Promise<string> {
  const line = `DONE: until ${session.until.label} · ${session.steps.length} steps · ${((Date.now() - session.startedAt) / 1000).toFixed(1)}s`
  if (!session.saveAs) return line
  const saved = await save(session, session.saveAs)
  return `${line} · saved ${saved.ok ? saved.data : saved.error}`
}

function isUntilMet({ session, deps }: Run): Promise<boolean> {
  return onLiveConn(deps, async () => !('error' in await findByLocator(deps.conn, session.until)))
}

/**
 * Settle, not sleep: poll until the until-condition holds, or the table changed and then
 * held still for SETTLE_STABLE_POLLS polls, or never changed for `quietPolls`, or the
 * budget runs out.
 */
async function finishStep(
  run: Run,
  { before, done, quietPolls = SETTLE_QUIET_POLLS }: { before: string; done: string; quietPolls?: number },
): Promise<ServerResponse> {
  const t0 = Date.now()
  let previous = before
  let hasChanged = false
  let stablePolls = 0
  let controls: Control[] = []
  let isDone = false
  do {
    await new Promise(r => setTimeout(r, SETTLE_POLL_MS))
    // A socket that dies again mid-reload is a document between loads: an empty table.
    controls = await unlessDeadSocket(snapshot(run), [])
    isDone = await unlessDeadSocket(isUntilMet(run), false)
    if (isDone) break
    const key = tableKey(controls)
    // An empty table is a document between loads, never a settled screen.
    if (controls.length === 0 || key !== previous) {
      hasChanged = true
      stablePolls = 0
    } else {
      stablePolls++
    }
    previous = key
  } while (stablePolls < (hasChanged ? SETTLE_STABLE_POLLS : quietPolls) && Date.now() - t0 < SETTLE_BUDGET_MS)
  const elapsed = Date.now() - t0

  if (isDone) return { ok: true, data: await doneLine(run.session) }
  const table = await printTable(run, controls)
  const { session } = run
  if (session.steps.length >= session.maxSteps) return { ok: true, data: `BLOCKED: step budget ${session.maxSteps} exhausted\n${table}` }
  return { ok: true, data: `✓ ${done} · ${elapsed}ms\n${table}` }
}

async function save(session: ActSession, name: string | undefined): Promise<ServerResponse> {
  if (!isScriptName(name)) return { ok: false, error: 'act save <name> — letters, digits, . _ - only' }
  const path = await writeScript(name, { until: session.untilArgs, steps: session.steps })
  return { ok: true, data: `${path} · replay: agent-view act replay ${name}` }
}
