import type { PageSession } from '../cdp/types.js'
import { isDeadSocket } from '../cdp/transport.js'
import type { ServerResponse } from '../types.js'
import { extractControls, type Control } from '../inspectors/controls/index.js'
import { findByLocator, locatorFromArgs, testIdAttributes, testIdLocator, type Locator } from './locator.js'
import { edgePoint, readScript, viewportBox, type ActScript, type StepTarget } from './act-script.js'

const POLL_MS = 50
const STEP_TIMEOUT_MS = 10_000
const UNTIL_TIMEOUT_MS = 15_000
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

/**
 * A saved `act` run, executed with no model and no settle: each step waits only until
 * its own target is on screen, enabled and uncovered, then acts. First line of the
 * result: `DONE` (until met), `FAIL` (the app did not answer: until never came, or a
 * control stayed disabled or covered — a bug) or `STALE` (a step's control is gone —
 * the script no longer fits the app). Its `after` chain runs first, prerequisites
 * whose own until already holds skipped; a prerequisite that is not DONE ends the run
 * with its verdict.
 */
export async function replay(
  { store, name, secret, testIdAttribute }: { store: string; name: string; secret?: string; testIdAttribute?: string },
  deps: ActDeps,
): Promise<ServerResponse> {
  // Prerequisites first: [login, …, name].
  const chain: { name: string; script: ActScript }[] = []
  for (let next: string | undefined = name; next;) {
    const seen: string[] = chain.map(c => c.name)
    if (seen.includes(next)) return { ok: false, error: `"${name}" after-chain loops: ${[...seen.reverse(), next].join(' → ')}` }
    const script = await readScript(store, next)
    if (!script) return { ok: false, error: `No saved script "${next}" — record one with act start … --save ${next}` }
    chain.unshift({ name: next, script })
    next = script.after
  }
  const attributes = testIdAttributes(testIdAttribute)

  const t0 = Date.now()
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
  const verdict = (exitCode: number, line: string): ServerResponse => ({ ok: true, data: `${line} · ${elapsed()}`, exitCode })
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
  const find = async (target: StepTarget, { isEnabledRequired }: { isEnabledRequired: boolean }) => {
    let seen: string | undefined
    const control = await poll(async (c): Promise<Control | undefined> => {
      deps.invalidateAxCache()
      const [ax, layout] = await Promise.all([c.getAccessibilityTree(), c.getLayoutSnapshot()])
      const hit = extractControls(ax, layout, attributes).find(ctl =>
        target.testid ? ctl.testid === target.testid : ctl.role === target.role && ctl.name === target.name)
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
  const findTestId = (testid: string) => poll(async (c) => {
    const found = await findByLocator(c, testIdLocator(testid, testIdAttribute))
    return 'error' in found ? undefined : found
  }, STEP_TIMEOUT_MS)
  const describe = (t: StepTarget) => (t.name ? `${t.role} "${t.name}"` : t.role) + (t.testid ? ` testid=${t.testid}` : '')
  const isShown = (until: Locator) => async (c: PageSession) => ('error' in await findByLocator(c, until) ? undefined : true)

  /** A FAIL / STALE verdict for the first step that could not run, or undefined when all ran. */
  const runSteps = async (script: ActScript, prefix: string): Promise<ServerResponse | undefined> => {
    for (const [i, step] of script.steps.entries()) {
      const at = `${prefix}step ${i + 1}/${script.steps.length}`
      if (step.op === 'scroll') {
        await poll(async c => { await c.scrollViewport(step.direction); return true }, STEP_TIMEOUT_MS)
        continue
      }
      const { control, seen } = await find(step.target, { isEnabledRequired: step.op !== 'drag' })
      if (!control) {
        // Present but unusable is the app misbehaving; absent is the script out of date.
        return seen
          ? verdict(EXIT_FAIL, `FAIL: ${at} ${step.op} ${describe(step.target)} — still ${seen} after ${STEP_TIMEOUT_MS / 1000}s`)
          : verdict(EXIT_STALE, `STALE: ${at} ${step.op} ${describe(step.target)} — not on screen within ${STEP_TIMEOUT_MS / 1000}s`)
      }
      try {
        if (step.op !== 'drag') {
          if (step.op === 'click') {
            await deps.conn.clickByNodeId(control.backendDOMNodeId)
          } else if (step.op === 'type') {
            await deps.conn.fillByNodeId(control.backendDOMNodeId, step.isPassword ? secret! : step.value ?? '')
          } else {
            const outcome = await deps.conn.selectOption(control.backendDOMNodeId, step.value ?? '')
            const reason = outcome === 'no-option' ? `no option "${step.value}"` : 'not a native select'
            if (outcome !== 'ok') return verdict(EXIT_STALE, `STALE: ${at} select ${describe(step.target)} — ${reason}`)
          }
        } else {
          const to = step.to
          const dest = !to ? undefined : 'role' in to ? (await find(to, { isEnabledRequired: false })).control : await findTestId(to.testid)
          if (to && !dest) {
            const label = 'role' in to ? describe(to) : `testid=${to.testid}`
            return verdict(EXIT_STALE, `STALE: ${at} drag target ${label} not found`)
          }
          const from = await deps.conn.getBoxCenter(control.backendDOMNodeId)
          const box = dest ? await deps.conn.getBoxRect(dest.backendDOMNodeId, { scrollIntoView: false }) : await viewportBox(deps.conn)
          await deps.conn.dragBetweenPositions(from, edgePoint(box, step.edge), { mode: 'pointer' })
        }
      } catch (err) {
        // The window reloaded under the action (login, logout): it went out; the next poll reconnects.
        // Any other failure means the control vanished between finding and acting (a panel
        // that toggled shut): the app is not in the state the script was recorded in.
        if (!isDeadSocket(err)) {
          const reason = err instanceof Error ? err.message : String(err)
          return verdict(EXIT_STALE, `STALE: ${at} ${step.op} ${describe(step.target)} — ${reason}`)
        }
      }
    }
    return undefined
  }

  /** Steps, then the until condition: a verdict when the script did not reach DONE, else how long its steps took. */
  const runScript = async (current: string, script: ActScript, until: Locator, isMain: boolean): Promise<ServerResponse | string> => {
    if (script.steps.some(s => 'isPassword' in s && s.isPassword) && !secret) {
      return { ok: false, error: `"${current}" types a password — set AGENT_VIEW_SECRET` }
    }
    const stepsStart = Date.now()
    const failed = await runSteps(script, isMain ? '' : `prerequisite ${current}: `)
    if (failed) return failed
    // Split the total: our steps vs the app answering them (auth, reload) — only the first is ours to speed up.
    const stepsTime = `${((Date.now() - stepsStart) / 1000).toFixed(1)}s`
    const isMet = await poll(isShown(until), UNTIL_TIMEOUT_MS)
    const who = isMain ? `replay ${current}` : `prerequisite ${current}`
    return isMet ? stepsTime : verdict(EXIT_FAIL, `FAIL: ${who} — steps ran, ${until.label} not visible after ${UNTIL_TIMEOUT_MS / 1000}s`)
  }
  const untilOf = (current: string, script: ActScript): Locator | ServerResponse =>
    locatorFromArgs({ ...script.until, testIdAttribute })
    ?? { ok: false, error: `"${current}" has no done condition — re-record it with act start --until-testid …` }

  const { script } = chain.pop()!
  const prerequisites: string[] = []
  for (const pre of chain) {
    const until = untilOf(pre.name, pre.script)
    if ('ok' in until) return until
    // Checked once, no polling: an app already past the prerequisite (logged in) skips it.
    if (await isShown(until)(deps.conn).catch(() => undefined)) {
      prerequisites.push(`${pre.name} skipped`)
      continue
    }
    const ran = await runScript(pre.name, pre.script, until, false)
    if (typeof ran !== 'string') return ran
    prerequisites.push(`${pre.name} ran`)
  }
  const until = untilOf(name, script)
  if ('ok' in until) return until
  const stepsTime = await runScript(name, script, until, true)
  if (typeof stepsTime !== 'string') return stepsTime
  const after = prerequisites.length ? ` · after ${prerequisites.join(', ')}` : ''
  return verdict(EXIT_DONE, `DONE: replay ${name}${after} · ${script.steps.length} steps in ${stepsTime}, then ${until.label}`)
}
