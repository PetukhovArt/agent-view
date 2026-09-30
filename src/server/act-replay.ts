import type { PageSession, Point } from '../cdp/types.js'
import { isDeadSocket } from '../cdp/transport.js'
import type { ServerResponse } from '../types.js'
import { extractControls, type Control } from '../inspectors/controls/index.js'
import { findByLocator, locatorFromArgs, testIdAttributes, type Locator } from './locator.js'
import {
  DEFAULT_UNTIL_TIMEOUT_S,
  clickNode,
  describeTarget,
  dragNode,
  elementLocator,
  fillParams,
  findScript,
  isClickOp,
  isRowTarget,
  isScriptName,
  isUseCase,
  paramsOf,
  pointIn,
  type ActScript,
  type ElementTarget,
  type RowTarget,
  type SavedScript,
  type Target,
} from './act-script.js'

const POLL_MS = 50
const STEP_TIMEOUT_MS = 10_000
const UNTIL_TIMEOUT_MS = DEFAULT_UNTIL_TIMEOUT_S * 1000
const EXIT_DONE = 0
const EXIT_FAIL = 1
const EXIT_STALE = 3

/** What an act run needs from the server. */
export type ActDeps = {
  /** Replaced by `reconnect` when the window reloads under a step. */
  conn: PageSession
  invalidateAxCache: () => void
  /** Fresh session after the window reloaded under us. */
  reconnect: () => Promise<PageSession>
}

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
      chain.push({ name: entry.step, script: fillParams(found.script, entry.params ?? {}), untilMs: untilMs(entry.timeout ?? found.script.timeout) })
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
    chain.unshift({ name: next, script: fillParams(found.script, params), untilMs: untilMs(found.script.timeout) })
    next = found.script.after
  }
  return { chain, main: chain.pop()!, linkWord: 'prerequisite', requires: [] }
}

/**
 * A saved `act` run, executed with no model and no settle: each step waits only until
 * its own target is on screen, enabled and uncovered, then acts. First line of the
 * result: `DONE` (until met), `FAIL` (the app did not answer: until never came, or a
 * control stayed disabled or covered — a bug) or `STALE` (a step's control is gone —
 * the script no longer fits the app). Its `after` chain, or a use case's steps, run
 * first, from the nearest one whose own until already holds; one that is not DONE ends
 * the run with its verdict. `${NAME}` in any script of the chain takes `params[NAME]`; one
 * missing refuses the run before its first step.
 */
export async function replay(
  { store, name, secret, params = {}, testIdAttribute }:
    { store: string; name: string; secret?: string; params?: Record<string, string>; testIdAttribute?: string },
  deps: ActDeps,
): Promise<ServerResponse> {
  const plan = await planRun(store, name, params)
  if ('ok' in plan) return plan
  const { chain, linkWord } = plan
  const attributes = testIdAttributes(testIdAttribute)

  const t0 = Date.now()
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
  // Fixtures are files on disk: replay never runs them, only says which the run assumes.
  const requires = plan.requires.length ? `\nrequires (not run by replay): ${plan.requires.join(', ')}` : ''
  const verdict = (exitCode: number, line: string): ServerResponse => ({ ok: true, data: `${line} · ${elapsed()}${requires}`, exitCode })
  /** Polls until `probe` yields a value or time runs out; rides over the window reloading. */
  const poll = async <T>(probe: (c: PageSession) => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> => {
    const end = Date.now() + timeoutMs
    for (;;) {
      try {
        const value = await probe(deps.conn)
        if (value !== undefined) return value
      } catch (err) {
        if (!isDeadSocket(err)) throw err
        // Between documents the window is not there yet; the next poll tries again.
        deps.conn = await deps.reconnect().catch(() => deps.conn)
      }
      if (Date.now() > end) return undefined
      await new Promise(r => setTimeout(r, POLL_MS))
    }
  }
  /** The control, or why it is not usable yet: absent, or present but disabled / covered. */
  const find = async (target: RowTarget, { isEnabledRequired }: { isEnabledRequired: boolean }) => {
    let seen: string | undefined
    const control = await poll(async (c): Promise<Control | undefined> => {
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
    }, STEP_TIMEOUT_MS)
    return { control, seen }
  }
  const findElement = (target: ElementTarget) => poll(async (c) => {
    const found = await findByLocator(c, elementLocator(target, testIdAttribute))
    return 'error' in found ? undefined : found.backendDOMNodeId
  }, STEP_TIMEOUT_MS)
  /** The node a step acts on: a row found again, or any visible element (a canvas has no row). */
  const resolve = async (target: Target, isEnabledRequired: boolean): Promise<{ nodeId?: number; seen?: string }> => {
    if (!isRowTarget(target)) return { nodeId: await findElement(target) }
    const { control, seen } = await find(target, { isEnabledRequired })
    return { nodeId: control?.backendDOMNodeId, seen }
  }
  const isShown = (until: Locator) => async (c: PageSession) => ('error' in await findByLocator(c, until) ? undefined : true)

  /** A FAIL / STALE verdict for the first step that could not run, or undefined when all ran. */
  const runSteps = async (script: ActScript, prefix: string): Promise<ServerResponse | undefined> => {
    for (const [i, step] of script.steps.entries()) {
      const at = `${prefix}step ${i + 1}/${script.steps.length}`
      if (step.op === 'scroll') {
        let wheelAt: Point | undefined
        if (step.target) {
          const { nodeId } = await resolve(step.target, false)
          if (!nodeId) return verdict(EXIT_STALE, `STALE: ${at} scroll ${describeTarget(step.target)} — not on screen within ${STEP_TIMEOUT_MS / 1000}s`)
          wheelAt = pointIn(await deps.conn.getBoxRect(nodeId, { scrollIntoView: false }))
        }
        await poll(async c => { await c.scrollWheel(step.direction, wheelAt); return true }, STEP_TIMEOUT_MS)
        deps.invalidateAxCache()
        continue
      }
      const { nodeId, seen } = await resolve(step.target, step.op !== 'drag')
      if (!nodeId) {
        // Present but unusable is the app misbehaving; absent is the script out of date.
        return seen
          ? verdict(EXIT_FAIL, `FAIL: ${at} ${step.op} ${describeTarget(step.target)} — still ${seen} after ${STEP_TIMEOUT_MS / 1000}s`)
          : verdict(EXIT_STALE, `STALE: ${at} ${step.op} ${describeTarget(step.target)} — not on screen within ${STEP_TIMEOUT_MS / 1000}s`)
      }
      try {
        if (step.op === 'drag') {
          const dropId = step.to && (await resolve(step.to, false)).nodeId
          if (step.to && !dropId) return verdict(EXIT_STALE, `STALE: ${at} drag target ${describeTarget(step.to)} not found`)
          await dragNode(deps.conn, nodeId, { at: step.at, dropId, toAt: step.toAt, edge: step.edge, isHtml5: step.isHtml5 })
        } else if (isClickOp(step.op)) {
          await clickNode(deps.conn, nodeId, step.op, step.at)
        } else if (step.op === 'type') {
          await deps.conn.fillByNodeId(nodeId, step.isPassword ? secret! : step.value ?? '')
        } else {
          const outcome = await deps.conn.selectOption(nodeId, step.value ?? '')
          const reason = outcome === 'no-option' ? `no option "${step.value}"` : 'not a native select'
          if (outcome !== 'ok') return verdict(EXIT_STALE, `STALE: ${at} select ${describeTarget(step.target)} — ${reason}`)
        }
      } catch (err) {
        // The window reloaded under the action (login, logout): it went out; the next poll reconnects.
        // Any other failure means the control vanished between finding and acting (a panel
        // that toggled shut): the app is not in the state the script was recorded in.
        if (!isDeadSocket(err)) {
          const reason = err instanceof Error ? err.message : String(err)
          return verdict(EXIT_STALE, `STALE: ${at} ${step.op} ${describeTarget(step.target)} — ${reason}`)
        }
      }
      // A `dom` right after the replay must not get the tree from before the last action.
      deps.invalidateAxCache()
    }
    return undefined
  }

  /** Steps, then the until condition: a verdict when the script did not reach DONE, else how long its steps took. */
  const runScript = async ({ name: current, script, untilMs }: Link, until: Locator, isMain: boolean): Promise<ServerResponse | string> => {
    if (script.steps.some(s => 'isPassword' in s && s.isPassword) && !secret) {
      return { ok: false, error: `"${current}" types a password — set AGENT_VIEW_SECRET` }
    }
    const stepsStart = Date.now()
    const failed = await runSteps(script, isMain ? '' : `${linkWord} ${current}: `)
    if (failed) return failed
    // Split the total: our steps vs the app answering them (auth, reload) — only the first is ours to speed up.
    const stepsTime = `${((Date.now() - stepsStart) / 1000).toFixed(1)}s`
    const isMet = await poll(isShown(until), untilMs)
    const who = isMain ? `replay ${current}` : `${linkWord} ${current}`
    return isMet ? stepsTime : verdict(EXIT_FAIL, `FAIL: ${who} — steps ran, ${until.label} not visible after ${untilMs / 1000}s`)
  }
  const untilOf = (current: string, script: ActScript): Locator | ServerResponse =>
    locatorFromArgs({ ...script.until, testIdAttribute })
    ?? { ok: false, error: `"${current}" has no done condition — re-record it with act start --until-testid …` }

  const { script } = plan.main
  const untils: Locator[] = []
  for (const pre of chain) {
    const until = untilOf(pre.name, pre.script)
    if ('ok' in until) return until
    untils.push(until)
  }
  // Checked once, no polling. An `after` chain goes nearest first: a prerequisite already reached (logged in, a
  // menu open) is skipped with every one before it, whose state its own next step may have consumed (a menu closed
  // by its item). A use case only skips its leading steps already reached: a later step's until may hold from the
  // start (a dialog closed, a tab active again) without the steps before it having run.
  const isReached = (i: number) => isShown(untils[i])(deps.conn).catch(() => undefined)
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
