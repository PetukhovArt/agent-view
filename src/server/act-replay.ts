import type { PageSession, Point } from '../cdp/types.js'
import { isDeadSocket, isNotDrawn } from '../cdp/transport.js'
import type { ServerResponse, WebGLEngine } from '../types.js'
import { extractControls, type Control } from '../inspectors/controls/index.js'
import { clickSceneObject, describePlace, moveSceneCamera, withHeight, type SceneMiss } from '../inspectors/scene/index.js'
import { findByLocator, testIdAttributes } from './locator.js'
import {
  CLICKS,
  DEFAULT_UNTIL_TIMEOUT_S,
  GLANCE_MS,
  clickNode,
  conditionOf,
  describeTarget,
  dragNode,
  elementLocator,
  exprCondition,
  fillParams,
  findScript,
  isClickOp,
  isRowTarget,
  isSceneClick,
  isScriptName,
  isUseCase,
  paramsOf,
  pointIn,
  unmet,
  type ActScript,
  type Condition,
  type ElementTarget,
  type NodeTarget,
  type RecordedStep,
  type RowTarget,
  type SavedScript,
  type SceneClickStep,
} from './act-script.js'

const POLL_MS = 50
export const STEP_TIMEOUT_MS = 10_000
const UNTIL_TIMEOUT_MS = DEFAULT_UNTIL_TIMEOUT_S * 1000
const EXIT_DONE = 0
const EXIT_FAIL = 1
const EXIT_STALE = 3
export const ALLOW_EVAL_HINT = 'Set "allowEval": true in agent-view.config.json to enable it.'

/** What an act run needs from the server. */
export type ActDeps = {
  /** Replaced by `reconnect` when the window reloads under a step. */
  conn: PageSession
  invalidateAxCache: () => void
  /** Fresh session after the window reloaded under us. */
  reconnect: () => Promise<PageSession>
  /** The project's `allowEval`: an expression until or wait step runs page JS. */
  isEvalAllowed: boolean
  /** The project's WebGL engine: scene click and goto steps need one that maps objects to places. */
  engine?: WebGLEngine
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Polls until `probe` yields a value or time runs out; rides over the window reloading. */
async function poll<T>(deps: ActDeps, probe: (c: PageSession, msLeft: number) => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = await probe(deps.conn, Math.max(end - Date.now(), POLL_MS))
      if (value !== undefined) return value
    } catch (err) {
      if (!isDeadSocket(err)) throw err
      // Between documents the window is not there yet; the next poll tries again.
      deps.conn = await deps.reconnect().catch(() => deps.conn)
    }
    if (Date.now() > end) return undefined
    await sleep(POLL_MS)
  }
}

/** Polls `condition` for `timeoutMs`: undefined once it holds, else why it still did not. */
export async function waitFor(deps: ActDeps, condition: Condition, timeoutMs: number): Promise<string | undefined> {
  let reason: string | undefined
  const isMet = await poll(deps, async (c, msLeft) => {
    reason = await unmet(c, condition, msLeft)
    return reason ? undefined : true
  }, timeoutMs)
  return isMet ? undefined : reason ?? 'not reached'
}

/**
 * Polls `probe` for a step's time until it answers no miss (a scene still loading, a camera still flying):
 * its answer, else the last miss. A `fatal` miss ends the polling at once.
 */
export async function untilAnswered<T extends object>(deps: ActDeps, probe: (c: PageSession) => Promise<T | SceneMiss>): Promise<T | SceneMiss> {
  let miss: SceneMiss = { error: 'the page did not answer', reason: 'missing' }
  const answer = await poll(deps, async (c) => {
    const result = await probe(c)
    if (!('error' in result) || result.reason === 'fatal') return result
    miss = result
    return undefined
  }, STEP_TIMEOUT_MS)
  return answer ?? miss
}

const hasExpression = (script: ActScript) => script.until.expr !== undefined || script.steps.some(s => s.op === 'wait')

/** One script of a run with the time its until may take. */
type Link = { name: string; script: ActScript; untilMs: number }
/**
 * What a replay runs: `chain` in order, then `main`. `linkWord` names a chain link in verdicts:
 * `prerequisite` of an `after` chain, `step` of a use case.
 */
type Plan = { chain: Link[]; main: Link; linkWord: 'prerequisite' | 'step'; requires: string[] }

const untilMs = (seconds: number | undefined) => (seconds ? seconds * 1000 : UNTIL_TIMEOUT_MS)
const noScript = (name: string): ServerResponse => ({ ok: false, error: `No saved script "${name}" — record one with act start … --save ${name}` })
/** A refusal when `values` leaves a parameter of `script` unset (an empty value is unset). */
const unset = (script: SavedScript, values: Record<string, string> | undefined, refuse: (names: string) => string): ServerResponse | undefined => {
  const missing = paramsOf(script).filter(p => !values?.[p])
  return missing.length ? { ok: false, error: refuse(missing.join(', ')) } : undefined
}
/** `script` with each goto step's filled `--height` set in its place, or a refusal when one is no number or doubles the place's. */
const placeHeights = (name: string, script: ActScript): ActScript | ServerResponse => {
  const steps: RecordedStep[] = []
  for (const step of script.steps) {
    if (step.op !== 'goto' || step.height === undefined) {
      steps.push(step)
      continue
    }
    const place = withHeight(step.place, step.height)
    if ('error' in place) return { ok: false, error: `"${name}": goto ${describePlace(step.place)} — ${place.error}` }
    steps.push({ op: 'goto', place })
  }
  return { ...script, steps }
}

/**
 * A step script with its `after` chain, prerequisites first; or a use case: its steps in order, each
 * filled with its own parameter values, their `after` not run, and a main link that only waits for
 * the use case's until.
 */
async function planRun(store: string, name: string, params: Record<string, string>): Promise<Plan | ServerResponse> {
  const top = await findScript(store, name)
  if (!top) return noScript(name)
  if (isUseCase(top.script)) {
    const refused = unset(top.script, params, names => `"${name}" needs ${names} — set as env vars`)
    if (refused) return refused
    const useCase = fillParams(top.script, params)
    const chain: Link[] = []
    for (const entry of useCase.use) {
      const found = await findScript(store, entry.step)
      if (!found) return noScript(entry.step)
      if (isUseCase(found.script)) return { ok: false, error: `"${name}": "${entry.step}" is a use case, not a step` }
      const unbound = unset(found.script, entry.params, names => `"${name}": step "${entry.step}" needs ${names} — bind it in the use case`)
      if (unbound) return unbound
      const script = placeHeights(entry.step, fillParams(found.script, entry.params ?? {}))
      if ('ok' in script) return script
      chain.push({ name: entry.step, script, untilMs: untilMs(entry.timeout ?? found.script.timeout) })
    }
    const main = { name, script: { until: useCase.until, steps: [] }, untilMs: UNTIL_TIMEOUT_MS }
    return { chain, main, linkWord: 'step', requires: useCase.requires ?? [] }
  }
  // Prerequisites first: [login, …, name].
  const chain: Link[] = []
  for (let next: string | undefined = name; next;) {
    const seen: string[] = chain.map(c => c.name)
    if (seen.includes(next)) return { ok: false, error: `"${name}" after-chain loops: ${[...seen.reverse(), next].join(' → ')}` }
    if (!isScriptName(next)) return { ok: false, error: `"${chain[0].name}" has an invalid after: "${next}"` }
    const found = await findScript(store, next)
    if (!found) return noScript(next)
    if (isUseCase(found.script)) return { ok: false, error: `"${chain[0].name}" is after a use case, "${next}" — only a step can be` }
    const current = next
    const refused = unset(found.script, params, names => `"${current}" needs ${names} — set as env vars`)
    if (refused) return refused
    const script = placeHeights(current, fillParams(found.script, params))
    if ('ok' in script) return script
    chain.unshift({ name: next, script, untilMs: untilMs(found.script.timeout) })
    next = found.script.after
  }
  return { chain, main: chain.pop()!, linkWord: 'prerequisite', requires: [] }
}

/**
 * A saved `act` run, executed with no model and no settle: each step waits only until
 * its own target is on screen, enabled and uncovered, then acts. First line of the
 * result: `DONE` (until met), `FAIL` (the app did not answer: until never came, or a
 * control or scene object stayed disabled or covered — a bug) or `STALE` (a step's control
 * or scene object is gone or no longer unique — the script no longer fits the app). Its `after` chain, or a use case's steps, run
 * first, from the nearest one whose own until already holds; one that is not DONE ends
 * the run with its verdict. `${NAME}` in any script of the chain takes `params[NAME]`; one
 * missing, or a goto `--height` filled with no number, refuses the run before its first step.
 */
export async function replay(
  { store, name, secret, params = {}, testIdAttribute }:
    { store: string; name: string; secret?: string; params?: Record<string, string>; testIdAttribute?: string },
  deps: ActDeps,
): Promise<ServerResponse> {
  const plan = await planRun(store, name, params)
  if ('ok' in plan) return plan
  const { chain, linkWord } = plan
  const isEvalRefused = !deps.isEvalAllowed && [...chain, plan.main].some(link => hasExpression(link.script))
  if (isEvalRefused) {
    return { ok: false, error: `"${name}" evaluates JS in the page (an --until-expr or a wait --expr). ${ALLOW_EVAL_HINT}` }
  }
  const attributes = testIdAttributes(testIdAttribute)

  const t0 = Date.now()
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
  // Fixtures are files on disk: replay never runs them, only says which the run assumes.
  const requires = plan.requires.length ? `\nrequires (not run by replay): ${plan.requires.join(', ')}` : ''
  const verdict = (exitCode: number, line: string): ServerResponse => ({ ok: true, data: `${line} · ${elapsed()}${requires}`, exitCode })
  /** A scene step's miss: refused when nothing can answer, FAIL for an object that stayed covered, else STALE. */
  const missed = (what: string, miss: SceneMiss): ServerResponse => {
    if (miss.reason === 'fatal') return { ok: false, error: `${what} — ${miss.error}` }
    const [exitCode, word] = miss.reason === 'covered' ? [EXIT_FAIL, 'FAIL'] : [EXIT_STALE, 'STALE']
    return verdict(exitCode, `${word}: ${what} — ${miss.error} after ${STEP_TIMEOUT_MS / 1000}s`)
  }
  /** The control, or why it is not usable yet: absent, or present but disabled / covered. */
  const find = async (target: RowTarget, { isEnabledRequired, timeoutMs }: { isEnabledRequired: boolean; timeoutMs: number }) => {
    let seen: string | undefined
    const control = await poll(deps, async (c): Promise<Control | undefined> => {
      deps.invalidateAxCache()
      const [ax, layout] = await Promise.all([c.getAccessibilityTree(), c.getLayoutSnapshot()])
      const matching = (controls: Control[]) => controls.filter(ctl =>
        target.testid ? ctl.testid === target.testid : ctl.role === target.role && ctl.name === target.name)[target.nth ?? 0]
      // A field just below the fold of a scrollable panel is laid out but off screen: take it,
      // the hit test below scrolls it into view.
      const hit = matching(extractControls(ax, layout, attributes))
        ?? matching(extractControls(ax, layout, attributes, { isOffscreenIncluded: true }))
      seen = undefined
      if (!hit) return undefined
      if (isEnabledRequired && hit.states.includes('disabled')) {
        seen = 'disabled'
        return undefined
      }
      let covering: string | null
      try {
        covering = await c.hitTest(hit.backendDOMNodeId, attributes)
      } catch (err) {
        if (isDeadSocket(err)) throw err
        return undefined // detached between the snapshot and the hit test: look again
      }
      if (covering) seen = `covered by ${covering}`
      return covering ? undefined : hit
    }, timeoutMs)
    return { control, seen }
  }
  const findElement = (target: ElementTarget, timeoutMs: number) => poll(deps, async (c) => {
    const found = await findByLocator(c, elementLocator(target, testIdAttribute))
    return 'error' in found ? undefined : found.backendDOMNodeId
  }, timeoutMs)
  /** The node a step acts on: a row found again, or any visible element (a canvas has no row). */
  const resolve = async (target: NodeTarget, isEnabledRequired: boolean, timeoutMs = STEP_TIMEOUT_MS): Promise<{ nodeId?: number; seen?: string }> => {
    if (!isRowTarget(target)) return { nodeId: await findElement(target, timeoutMs) }
    const { control, seen } = await find(target, { isEnabledRequired, timeoutMs })
    return { nodeId: control?.backendDOMNodeId, seen }
  }

  /**
   * Finds `target` and runs `use` on its node within the step's time: a FAIL / STALE verdict, or what `use`
   * returns. A node not drawn yet (a row a virtual list draws a frame later) or replaced by a re-render is
   * found again; any other failure means the app is not in the state the script was recorded in (a panel
   * that toggled shut).
   */
  const onNode = async (
    target: NodeTarget,
    { isEnabledRequired, what }: { isEnabledRequired: boolean; what: string },
    use: (nodeId: number, msLeft: number) => Promise<ServerResponse | undefined>,
  ): Promise<ServerResponse | undefined> => {
    const deadline = Date.now() + STEP_TIMEOUT_MS
    for (;;) {
      const { nodeId, seen } = await resolve(target, isEnabledRequired, deadline - Date.now())
      if (!nodeId) {
        // Present but unusable is the app misbehaving; absent is the script out of date.
        return seen
          ? verdict(EXIT_FAIL, `FAIL: ${what} — still ${seen} after ${STEP_TIMEOUT_MS / 1000}s`)
          : verdict(EXIT_STALE, `STALE: ${what} — not on screen within ${STEP_TIMEOUT_MS / 1000}s`)
      }
      try {
        return await use(nodeId, deadline - Date.now())
      } catch (err) {
        if (isDeadSocket(err)) throw err
        const isRetried = isNotDrawn(err) && Date.now() < deadline
        if (!isRetried) return verdict(EXIT_STALE, `STALE: ${what} — ${err instanceof Error ? err.message : String(err)}`)
      }
      await sleep(POLL_MS)
    }
  }

  type ActionStep = Exclude<RecordedStep, { op: 'scroll' | 'wait' | 'goto' } | SceneClickStep>
  /** Acts on the found node: a verdict when the app cannot take the step, else undefined. */
  const actOn = async (step: ActionStep, nodeId: number, at: string, msLeft: number): Promise<ServerResponse | undefined> => {
    try {
      if (step.op === 'drag') {
        const dropId = step.to && (await resolve(step.to, false, msLeft)).nodeId
        if (step.to && !dropId) return verdict(EXIT_STALE, `STALE: ${at} drag target ${describeTarget(step.to)} not found`)
        await dragNode(deps.conn, nodeId, { at: step.at, dropId, toAt: step.toAt, edge: step.edge, isHtml5: step.isHtml5 })
      } else if (isClickOp(step.op)) {
        await clickNode(deps.conn, nodeId, step.op, { at: step.at, modifiers: step.modifiers })
      } else if (step.op === 'type') {
        await deps.conn.fillByNodeId(nodeId, step.isPassword ? secret! : step.value ?? '')
      } else {
        const outcome = await deps.conn.selectOption(nodeId, step.value ?? '')
        const reason = outcome === 'no-option' ? `no option "${step.value}"` : 'not a native select'
        if (outcome !== 'ok') return verdict(EXIT_STALE, `STALE: ${at} select ${describeTarget(step.target)} — ${reason}`)
      }
    } catch (err) {
      // The window reloaded under the action (login, logout): it went out; the next poll reconnects.
      if (!isDeadSocket(err)) throw err
    }
    return undefined
  }

  /** A FAIL / STALE verdict for the first step that could not run, or undefined when all ran. */
  const runSteps = async (script: ActScript, prefix: string): Promise<ServerResponse | undefined> => {
    for (const [i, step] of script.steps.entries()) {
      const at = `${prefix}step ${i + 1}/${script.steps.length}`
      if (step.op === 'scroll') {
        let wheelAt: Point | undefined
        if (step.target) {
          const failed = await onNode(step.target, { isEnabledRequired: false, what: `${at} scroll ${describeTarget(step.target)}` }, async (nodeId) => {
            wheelAt = pointIn(await deps.conn.getBoxRect(nodeId, { scrollIntoView: false }))
            return undefined
          })
          if (failed) return failed
        }
        await poll(deps, async c => { await c.scrollWheel(step.direction, wheelAt); return true }, STEP_TIMEOUT_MS)
        deps.invalidateAxCache()
        continue
      }
      if (step.op === 'wait') {
        const condition = exprCondition(step.expr)
        const reason = await waitFor(deps, condition, STEP_TIMEOUT_MS)
        if (reason) return verdict(EXIT_FAIL, `FAIL: ${at} wait ${condition.label} ${reason} after ${STEP_TIMEOUT_MS / 1000}s`)
        continue
      }
      if (step.op === 'goto') {
        const moved = await untilAnswered(deps, c => moveSceneCamera(c, deps.engine, step.place))
        if ('error' in moved) return missed(`${at} goto ${describePlace(step.place)}`, moved)
        continue
      }
      if (isSceneClick(step)) {
        const opts = { ...CLICKS[step.op], modifiers: step.modifiers }
        const clicked = await untilAnswered(deps, c => clickSceneObject(c, deps.engine, step.target.scene, opts))
        if ('error' in clicked) return missed(`${at} ${step.op} ${describeTarget(step.target)}`, clicked)
        deps.invalidateAxCache()
        continue
      }
      const what = `${at} ${step.op} ${describeTarget(step.target)}`
      const failed = await onNode(step.target, { isEnabledRequired: step.op !== 'drag', what }, (nodeId, msLeft) => actOn(step, nodeId, at, msLeft))
      if (failed) return failed
      // A `dom` right after the replay must not get the tree from before the last action.
      deps.invalidateAxCache()
    }
    return undefined
  }

  /** Steps, then the until condition: a verdict when the script did not reach DONE, else how long its steps took. */
  const runScript = async ({ name: current, script, untilMs }: Link, until: Condition, isMain: boolean): Promise<ServerResponse | string> => {
    if (script.steps.some(s => 'isPassword' in s && s.isPassword) && !secret) {
      return { ok: false, error: `"${current}" types a password — set AGENT_VIEW_SECRET` }
    }
    const stepsStart = Date.now()
    const failed = await runSteps(script, isMain ? '' : `${linkWord} ${current}: `)
    if (failed) return failed
    // Split the total: our steps vs the app answering them (auth, reload) — only the first is ours to speed up.
    const stepsTime = `${((Date.now() - stepsStart) / 1000).toFixed(1)}s`
    const reason = await waitFor(deps, until, untilMs)
    const who = isMain ? `replay ${current}` : `${linkWord} ${current}`
    return reason ? verdict(EXIT_FAIL, `FAIL: ${who} — steps ran, ${until.label} ${reason} after ${untilMs / 1000}s`) : stepsTime
  }
  const untilOf = (current: string, script: ActScript): Condition | ServerResponse =>
    conditionOf(script.until, testIdAttribute)
    ?? { ok: false, error: `"${current}" has no done condition — re-record it with act start --until-testid …` }

  const { script } = plan.main
  const untils: Condition[] = []
  for (const pre of chain) {
    const until = untilOf(pre.name, pre.script)
    if ('ok' in until) return until
    untils.push(until)
  }
  // Checked once, no polling. An `after` chain goes nearest first: a prerequisite already reached (logged in, a
  // menu open) is skipped with every one before it, whose state its own next step may have consumed (a menu closed
  // by its item). A use case only skips its leading steps already reached: a later step's until may hold from the
  // start (a dialog closed, a tab active again) without the steps before it having run.
  const isReached = (i: number) => unmet(deps.conn, untils[i], GLANCE_MS).then(reason => !reason, () => false)
  let firstToRun = linkWord === 'step' ? 0 : chain.length
  if (linkWord === 'step') {
    while (firstToRun < chain.length && await isReached(firstToRun)) firstToRun++
  } else {
    while (firstToRun > 0 && !await isReached(firstToRun - 1)) firstToRun--
  }
  const prerequisites = chain.slice(0, firstToRun).map(pre => `${pre.name} skipped`)
  for (const [i, pre] of chain.entries()) {
    if (i < firstToRun) continue
    const ran = await runScript(pre, untils[i], false)
    if (typeof ran !== 'string') return ran
    prerequisites.push(`${pre.name} ran`)
  }
  const until = untilOf(name, script)
  if ('ok' in until) return until
  const stepsTime = await runScript(plan.main, until, true)
  if (typeof stepsTime !== 'string') return stepsTime
  if (linkWord === 'step') return verdict(EXIT_DONE, `DONE: replay ${name} · ${prerequisites.join(', ')}, then ${until.label}`)
  const after = prerequisites.length ? ` · after ${prerequisites.join(', ')}` : ''
  return verdict(EXIT_DONE, `DONE: replay ${name}${after} · ${script.steps.length} steps in ${stepsTime}, then ${until.label}`)
}
