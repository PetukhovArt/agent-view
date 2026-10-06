import { isDeadSocket } from '../cdp/transport.js'
import type { Modifier } from '../cdp/types.js'
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
import { findByLocator, testIdAttributes } from './locator.js'
import { clickSceneObject, moveSceneCamera, parseScenePlace, withHeight } from '../inspectors/scene/index.js'
import {
  CLICKS,
  EDGES,
  GLANCE_MS,
  clickNode,
  conditionOf,
  describeAt,
  describeOp,
  describeTarget,
  dragNode,
  elementLocator,
  exprCondition,
  isClickOp,
  isEdge,
  isScriptName,
  markParams,
  parseParamNotes,
  refuseScript,
  withoutPasswords,
  parseTarget,
  pointIn,
  scriptStore,
  unmet,
  writeScript,
  type CliTarget,
  type ClickOp,
  type Condition,
  type NodeTarget,
  type RecordedStep,
  type RowTarget,
  type UntilArgs,
} from './act-script.js'
import { cwdOf, isOneUntil, modifiersOf, refuseStepSave, str, strs, untilArgsOf } from './act-store.js'
import { ALLOW_EVAL_HINT, STEP_TIMEOUT_MS, replay, untilAnswered, waitFor, type ActDeps } from './act-replay.js'

const DEFAULT_MAX_STEPS = 30
const SETTLE_POLL_MS = 100
const SETTLE_BUDGET_MS = 3_000
/** Polls the table must stay unchanged, after it changed, to count as settled. */
const SETTLE_STABLE_POLLS = 2
/** Polls an action that changed nothing waits before giving up on a reaction. */
const SETTLE_QUIET_POLLS = 4
const ROW_OPS = ['click', 'dblclick', 'rightclick', 'type', 'select'] as const
type RowOp = typeof ROW_OPS[number]
type RowStepArgs = { op: RowOp; n: number; text: string; modifiers?: Modifier[] }

/** How a replay finds `c` again, and which of the visible controls answering to the same it is. */
function stepTarget(c: Control, controls: Control[]): RowTarget {
  // Counted the way replay looks it up: by test id when there is one, else every control of that role + name.
  const same = controls.filter(o => (c.testid ? o.testid === c.testid : o.role === c.role && o.name === c.name))
  const nth = same.findIndex(o => o.backendDOMNodeId === c.backendDOMNodeId)
  return { testid: c.testid, role: c.role, name: c.name, nth: nth > 0 ? nth : undefined }
}

/** Step-protocol state for one CDP port. Rows are those of the LAST printed table. */
export type ActSession = {
  until: Condition
  untilArgs: UntilArgs
  maxSteps: number
  testIdAttribute?: string
  rows: Control[]
  steps: RecordedStep[]
  startedAt: number
  /** Script name to write on DONE (`act start --save`). */
  saveAs?: string
  /** The project dir the CLI ran in: where the script store is resolved on save. */
  cwd: string
  /** Store section `--save` writes to (`start --in`). */
  section?: string
  /** Seconds a replay gives the until (`start --timeout`). */
  timeout?: number
  note?: string
  start?: string
  after?: string
  /** `--param NAME=value` of `start`: marked in the script `--save` writes. */
  params?: string[]
  paramNotes?: string[]
  /** DONE was printed: the recording is complete and takes no more steps. */
  isDone: boolean
}

/** One act call: the port's session and this request's handles on the server. */
type Run = { session: ActSession; deps: ActDeps }

const num = (value: unknown): number => (typeof value === 'number' ? value : NaN)
const seconds = (value: unknown): number | undefined => (typeof value === 'number' && value > 0 ? value : undefined)
const isRowOp = (op: string): op is RowOp => (ROW_OPS as readonly string[]).includes(op)
/** Machine-agnostic: the hash route, else path + query of a web page; never origin or a file path. */
const START_EXPRESSION = "location.hash || (/^https?:$/.test(location.protocol) ? location.pathname + location.search : '')"

export async function runAct(
  holder: { act: ActSession | null },
  args: Record<string, unknown>,
  deps: ActDeps,
): Promise<ServerResponse> {
  const op = str(args, 'op') ?? ''
  if (op === 'replay') {
    const name = str(args, 'name')
    if (!isScriptName(name)) return { ok: false, error: 'act replay <name>' }
    const store = await scriptStore(cwdOf(args))
    const params = typeof args.params === 'object' && args.params ? args.params as Record<string, string> : undefined
    return replay({ store, name, secret: str(args, 'secret'), params, testIdAttribute: str(args, 'testIdAttribute') }, deps)
  }
  if (op === 'start') {
    // Done is agent-view's call, never the driver's: no run without a done condition.
    const untilArgs = untilArgsOf(args)
    if (!isOneUntil(untilArgs)) {
      return { ok: false, error: 'act start --until-testid <id> | --until-selector <css> | --until-expr <js> — exactly one' }
    }
    const isEvalRefused = untilArgs.expr !== undefined && !deps.isEvalAllowed
    if (isEvalRefused) {
      return { ok: false, error: `--until-expr evaluates JS in the page. ${ALLOW_EVAL_HINT}` }
    }
    if (str(args, 'save') !== undefined) {
      const refused = await refuseStepSave(await scriptStore(cwdOf(args)), str(args, 'save'), str(args, 'in')) ?? refuseDraft(args)
      if (refused) return refused
    }
    const start = await deps.conn.evaluate(START_EXPRESSION).catch(() => undefined)
    holder.act = { ...createSession(args), start: typeof start === 'string' && start ? start : undefined }
    return tableOrDone({ session: holder.act, deps })
  }
  const session = holder.act
  if (!session) return { ok: false, error: 'run `agent-view act start` first' }
  const run: Run = { session, deps }

  if (op === 'table') return tableOrDone(run)
  if (op === 'save') {
    return save(session, str(args, 'name'), {
      note: str(args, 'note'),
      after: str(args, 'after'),
      params: strs(args, 'params'),
      paramNotes: strs(args, 'paramNotes'),
      section: str(args, 'in'),
      timeout: seconds(args.timeout),
    })
  }
  const expr = str(args, 'expr')
  if (op === 'wait' && expr === undefined) return finishStep(run, { before: tableKey(await snapshot(run)), done: 'wait', quietPolls: Infinity })
  if (session.isDone) return { ok: false, error: 'this act run is DONE — `agent-view act start` for a new one' }
  if (session.steps.length >= session.maxSteps) {
    return { ok: true, data: `BLOCKED: step budget ${session.maxSteps} exhausted\n${await printTable(run)}` }
  }
  if (op === 'wait' && expr !== undefined) {
    return waitStep(run, expr)
  }
  if (op === 'scroll') return scrollStep(run, str(args, 'direction'), str(args, 'target'))
  if (op === 'goto') return gotoStep(run, str(args, 'place'), str(args, 'height'))
  if (op === 'drag') return dragStep(run, { from: str(args, 'target') ?? '', to: str(args, 'to'), edge: str(args, 'edge'), isHtml5: args.html5 === true })
  if (isClickOp(op) && str(args, 'target') !== undefined) {
    const target = parseTarget(str(args, 'target')!)
    if (!target) return { ok: false, error: `act ${op} <n | testid=<id> | css=<selector>>[@x,y] | scene=<object>` }
    const modifiers = modifiersOf(args)
    if (modifiers && 'error' in modifiers) return { ok: false, error: modifiers.error }
    if ('scene' in target) return sceneClickStep(run, op, target.scene, modifiers)
    if ('n' in target && !target.at) return rowStep(run, { op, n: target.n, text: '', modifiers })
    return clickStep(run, op, target, modifiers)
  }
  if (isRowOp(op)) return rowStep(run, { op, n: num(args.n), text: str(args, 'text') ?? '' })
  if (op === 'do') return batchStep(run, args.steps)
  return { ok: false, error: `Unknown act op: ${op}` }
}

/** What `act start --save` can refuse before the run: all but a param note, which needs the steps. */
function refuseDraft(args: Record<string, unknown>): ServerResponse | undefined {
  const notes = parseParamNotes(strs(args, 'paramNotes'))
  const unfit = notes && 'error' in notes
    ? notes.error
    : refuseScript({ until: untilArgsOf(args), steps: [], note: str(args, 'note') }, strs(args, 'params'))
  return unfit ? { ok: false, error: unfit } : undefined
}

function createSession(args: Record<string, unknown>): ActSession {
  const untilArgs = untilArgsOf(args)
  const testIdAttribute = str(args, 'testIdAttribute')
  const maxSteps = typeof args.maxSteps === 'number' && args.maxSteps > 0 ? args.maxSteps : DEFAULT_MAX_STEPS
  return {
    until: conditionOf(untilArgs, testIdAttribute)!,
    untilArgs,
    maxSteps,
    testIdAttribute,
    rows: [],
    steps: [],
    startedAt: Date.now(),
    saveAs: str(args, 'save'),
    cwd: cwdOf(args),
    section: str(args, 'in'),
    timeout: seconds(args.timeout),
    note: str(args, 'note'),
    after: str(args, 'after'),
    params: strs(args, 'params'),
    paramNotes: strs(args, 'paramNotes'),
    isDone: false,
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

async function rowStep(run: Run, { op, n, text, modifiers }: RowStepArgs): Promise<ServerResponse> {
  const located = await locate(run, n)
  if (!('target' in located)) return located
  const { target, fresh } = located
  if (op === 'type' && !TEXT_ROLES.has(target.role)) {
    return { ok: false, error: `[${n}] is a ${target.role}, not a text field — pick a textbox/combobox row` }
  }

  const { session, deps } = run
  const echo = isClickOp(op) ? '' : ` ${target.isPassword ? PASSWORD_MASK : JSON.stringify(text)}`
  const done = `${describeOp(op, modifiers)} [${n}] ${describeControl(target)}${echo}`
  let isReloaded = false
  try {
    if (isClickOp(op)) {
      await clickNode(deps.conn, target.backendDOMNodeId, op, { modifiers })
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
  session.steps.push({ op, target: stepTarget(target, fresh), value: isClickOp(op) ? undefined : text, isPassword: target.isPassword, modifiers })
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
    return { ok: false, error: `act do: "${bad}" — each step is ${ROW_OPS.join('|')} <n> [text]` }
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

type Picked = { nodeId: number; target: NodeTarget; label: string; before: string }

/** Row n of the last table (stale guard, hit check), or any visible element by test id / CSS — a canvas is no row. */
async function pick(run: Run, target: CliTarget): Promise<Picked | ServerResponse> {
  if ('scene' in target) return { ok: false, error: 'scene=<object> is a click target only' }
  if ('n' in target) {
    const located = await locate(run, target.n)
    if (!('target' in located)) return located
    const { target: control, fresh } = located
    const label = `[${target.n}] ${describeControl(control)}${control.testid ? ` testid=${control.testid}` : ''}`
    return { nodeId: control.backendDOMNodeId, target: stepTarget(control, fresh), label, before: tableKey(fresh) }
  }
  const found = await findByLocator(run.deps.conn, elementLocator(target.element, run.session.testIdAttribute))
  if ('error' in found) return { ok: false, error: found.error }
  return { nodeId: found.backendDOMNodeId, target: target.element, label: describeTarget(target.element), before: tableKey(await snapshot(run)) }
}

/** A click op on an element, or at `at` px from its top-left corner (a spot on a canvas). */
async function clickStep(run: Run, op: ClickOp, target: CliTarget, modifiers: Modifier[] | undefined): Promise<ServerResponse> {
  const picked = await pick(run, target)
  if (!('nodeId' in picked)) return picked
  const { session, deps } = run
  const { at } = target
  await clickNode(deps.conn, picked.nodeId, op, { at, modifiers })
  deps.invalidateAxCache()
  session.steps.push({ op, target: picked.target, isPassword: false, at, modifiers })
  return finishStep(run, { before: picked.before, done: `${describeOp(op, modifiers)} ${picked.label}${describeAt(at)}` })
}

/** A click op on a scene object once it is drawn and takes the click, as replay waits for it; it has no row and no DOM node. */
async function sceneClickStep(run: Run, op: ClickOp, query: string, modifiers: Modifier[] | undefined): Promise<ServerResponse> {
  const { session, deps } = run
  const before = tableKey(await snapshot(run))
  const found = await untilAnswered(deps, `${op} scene=${query}`, c => clickSceneObject(c, deps.engine, query, { ...CLICKS[op], modifiers }))
  if ('line' in found) return { ok: false, error: `${found.line} — not recorded` }
  deps.invalidateAxCache()
  session.steps.push({ op, target: { scene: query }, modifiers })
  return finishStep(run, { before, done: `${describeOp(op, modifiers)} scene=${query} at (${found.x}, ${found.y})` })
}

/** The camera over a place: recorded, so a replay sees the scene the clicks after it were decided on. */
async function gotoStep(run: Run, raw: string | undefined, height: string | undefined): Promise<ServerResponse> {
  if (!raw) return { ok: false, error: 'act goto <lon,lat[,height] | scene object> [--height <metres>]' }
  const place = parseScenePlace(raw)
  const lifted = withHeight(place, height)
  if ('error' in lifted) return { ok: false, error: lifted.error }
  const before = tableKey(await snapshot(run))
  const moved = await moveSceneCamera(run.deps.conn, run.deps.engine, lifted)
  if ('error' in moved) return { ok: false, error: moved.error }
  run.session.steps.push({ op: 'goto', place, ...(height === undefined ? {} : { height }) })
  return finishStep(run, { before, done: moved.text })
}

/**
 * Pointer drag of a row or element (from its centre, or `@x,y`) onto: an edge of row `to` or
 * of any element (drop zones are rarely controls), a point `@x,y` in it, or the viewport.
 */
async function dragStep(
  run: Run,
  { from, to, edge = 'center', isHtml5 }: { from: string; to?: string; edge?: string; isHtml5?: boolean },
): Promise<ServerResponse> {
  const usage = `act drag <n | testid=<id> | css=<selector>>[@x,y] [to[@x,y]] [edge] [--html5] — edge is one of ${EDGES.join('|')}`
  const source = parseTarget(from)
  const dest = to === undefined || to === 'center' ? undefined : parseTarget(to)
  if (!isEdge(edge) || !source || (to !== undefined && to !== 'center' && !dest)) return { ok: false, error: usage }
  const { session, deps } = run
  const picked = await pick(run, source)
  if (!('nodeId' in picked)) return picked
  const drop = dest && await pick(run, dest)
  if (drop && !('nodeId' in drop)) return drop
  await dragNode(deps.conn, picked.nodeId, { at: source.at, dropId: drop?.nodeId, toAt: dest?.at, edge, isHtml5 })
  deps.invalidateAxCache()
  session.steps.push({ op: 'drag', target: picked.target, at: source.at, to: drop?.target, edge, toAt: dest?.at, isHtml5: isHtml5 || undefined })
  const toLabel = `${drop?.label ?? 'viewport'}${dest?.at ? describeAt(dest.at) : ` ${edge}`}`
  return finishStep(run, { before: picked.before, done: `drag ${picked.label}${describeAt(source.at)} → ${toLabel}` })
}

/** Wheel at the viewport centre, or over a row / element — a panel scrolls only under the pointer. */
async function scrollStep(run: Run, direction: string | undefined, over: string | undefined): Promise<ServerResponse> {
  const target = over === undefined ? undefined : parseTarget(over)
  if ((direction !== 'up' && direction !== 'down') || (over !== undefined && (!target || target.at))) {
    return { ok: false, error: 'act scroll <up|down> [n | testid=<id> | css=<selector>]' }
  }
  const picked = target && await pick(run, target)
  if (picked && !('nodeId' in picked)) return picked
  const before = picked?.before ?? tableKey(await snapshot(run))
  const at = picked ? pointIn(await run.deps.conn.getBoxRect(picked.nodeId, { scrollIntoView: false })) : undefined
  await run.deps.conn.scrollWheel(direction, at)
  run.deps.invalidateAxCache()
  run.session.steps.push({ op: 'scroll', direction, target: picked?.target })
  return finishStep(run, { before, done: `scroll ${direction}${picked ? ` ${picked.label}` : ''}` })
}

async function blocked(run: Run, reason: string, fresh: Control[]): Promise<ServerResponse> {
  return { ok: true, data: `BLOCKED: ${reason}\n${await printTable(run, fresh)}` }
}

const tableKey = (controls: Control[]): string => controls.map((c, i) => formatControlRow(c, i)).join('\n')

/** A table the decider asked for still ends the run when the goal was reached meanwhile. */
async function tableOrDone(run: Run): Promise<ServerResponse> {
  const table = await printTable(run)
  return { ok: true, data: await isUntilMet(run, GLANCE_MS) ? await doneLine(run.session) : table }
}

/** The DONE line; with `start --save`, the recording is written here, sparing the decider a turn. */
async function doneLine(session: ActSession): Promise<string> {
  const line = `DONE: until ${session.until.label} · ${session.steps.length} steps · ${((Date.now() - session.startedAt) / 1000).toFixed(1)}s`
  const isFirstDone = !session.isDone
  session.isDone = true
  if (!session.saveAs || !isFirstDone) return line
  const saved = await save(session, session.saveAs)
  return `${line} · saved ${saved.ok ? saved.data : saved.error}`
}

function isUntilMet({ session, deps }: Run, promiseWaitMs: number): Promise<boolean> {
  return onLiveConn(deps, async () => !await unmet(deps.conn, session.until, promiseWaitMs))
}

/** A wait recorded as a step, for a state no element shows; one that never holds is not recorded. */
async function waitStep(run: Run, expr: string): Promise<ServerResponse> {
  if (!run.deps.isEvalAllowed) return { ok: false, error: `act wait --expr evaluates JS in the page. ${ALLOW_EVAL_HINT}` }
  const condition = exprCondition(expr)
  const before = tableKey(await snapshot(run))
  const reason = await waitFor(run.deps, condition, STEP_TIMEOUT_MS)
  if (reason) return { ok: false, error: `wait ${condition.label} ${reason} after ${STEP_TIMEOUT_MS / 1000}s — not recorded` }
  run.session.steps.push({ op: 'wait', expr })
  return finishStep(run, { before, done: `wait ${condition.label}` })
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
    isDone = await unlessDeadSocket(isUntilMet(run, Math.max(SETTLE_BUDGET_MS - (Date.now() - t0), SETTLE_POLL_MS)), false)
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

async function save(
  session: ActSession,
  name: string | undefined,
  {
    note = session.note,
    after = session.after,
    params = session.params ?? [],
    paramNotes = session.paramNotes,
    section = session.section,
    timeout = session.timeout,
  }: Partial<Pick<ActSession, 'note' | 'after' | 'params' | 'paramNotes' | 'section' | 'timeout'>> = {},
): Promise<ServerResponse> {
  const store = await scriptStore(session.cwd)
  const refused = await refuseStepSave(store, name, section)
  if (refused) return refused
  if (after !== undefined && (!isScriptName(after) || after === name)) {
    return { ok: false, error: '--after <name> — another saved script, letters, digits, . _ - only' }
  }
  const notes = parseParamNotes(paramNotes)
  if (notes && 'error' in notes) return { ok: false, error: notes.error }
  // Passwords out before the checks, so no refusal can echo one.
  const script = markParams({ until: session.untilArgs, steps: withoutPasswords(session.steps), note, paramNotes: notes, start: session.start, after, timeout }, params)
  if ('error' in script) return { ok: false, error: script.error }
  const unfit = refuseScript(script, params)
  if (unfit) return { ok: false, error: unfit }
  const path = await writeScript({ store, name: name!, section }, script)
  return { ok: true, data: `${path} · replay: agent-view act replay ${name}` }
}
