import { readFile } from 'node:fs/promises'
import type { PageSession } from '../cdp/types.js'
import type { ServerResponse } from '../types.js'
import { extractControls, type Control } from '../inspectors/controls/index.js'
import { findByLocator, locatorFromArgs } from './locator.js'
import { edgePoint, isDeadSocket, scriptPath, viewportBox, type ActDeps, type ActScript, type StepTarget } from './act-session.js'

const POLL_MS = 50
const STEP_TIMEOUT_MS = 10_000
const UNTIL_TIMEOUT_MS = 15_000

/**
 * A saved `act` run, executed with no model and no settle: each step waits only until
 * its own target is on screen, enabled and uncovered, then acts. First line of the
 * result: `DONE` (until met), `FAIL` (steps ran, until never came — a bug) or `STALE`
 * (a step's control is gone — the script no longer fits the app).
 */
export async function replay(
  name: string,
  secret: string | undefined,
  testIdAttributes: readonly string[],
  testIdAttribute: string | undefined,
  deps: ActDeps,
): Promise<ServerResponse> {
  let script: ActScript
  try {
    script = JSON.parse(await readFile(scriptPath(name), 'utf8')) as ActScript
  } catch {
    return { ok: false, error: `No saved script "${name}" — record one with act start … act save ${name}` }
  }
  if (script.steps.some(s => 'isPassword' in s && s.isPassword) && !secret) {
    return { ok: false, error: `"${name}" types a password — set AGENT_VIEW_SECRET` }
  }

  const t0 = Date.now()
  let conn = deps.conn
  /** Polls until `probe` yields a value or time runs out; rides over the window reloading. */
  const poll = async <T>(probe: (c: PageSession) => Promise<T | undefined>, timeoutMs: number): Promise<T | undefined> => {
    const end = Date.now() + timeoutMs
    for (;;) {
      try {
        const value = await probe(conn)
        if (value !== undefined) return value
      } catch (err) {
        if (!isDeadSocket(err)) throw err
        conn = await deps.reconnect().catch(() => conn)
      }
      if (Date.now() > end) return undefined
      await new Promise(r => setTimeout(r, POLL_MS))
    }
  }
  const find = (target: StepTarget, needsEnabled: boolean) => poll(async (c): Promise<Control | undefined> => {
    deps.invalidateAxCache()
    const [ax, layout] = await Promise.all([c.getAccessibilityTree(), c.getLayoutSnapshot()])
    const hit = extractControls(ax, layout, testIdAttributes).find(ctl =>
      target.testid ? ctl.testid === target.testid : ctl.role === target.role && ctl.name === target.name)
    if (!hit || (needsEnabled && hit.states.includes('disabled'))) return undefined
    return await c.hitTest(hit.backendDOMNodeId, testIdAttributes) ? undefined : hit
  }, STEP_TIMEOUT_MS)
  const findTestId = (testid: string) => poll(async (c) => {
    const found = await findByLocator(c, locatorFromArgs({ testid, testIdAttribute })!)
    return 'error' in found ? undefined : found
  }, STEP_TIMEOUT_MS)
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
  const describe = (t: StepTarget) => (t.name ? `${t.role} "${t.name}"` : t.role) + (t.testid ? ` testid=${t.testid}` : '')

  for (const [i, step] of script.steps.entries()) {
    if (step.op === 'scroll') {
      await conn.scrollViewport(step.direction)
      continue
    }
    const control = await find(step.target, step.op !== 'drag')
    if (!control) {
      return { ok: true, data: `STALE: step ${i + 1}/${script.steps.length} ${step.op} ${describe(step.target)} — not on screen, enabled and uncovered within ${STEP_TIMEOUT_MS / 1000}s · ${elapsed()}` }
    }
    try {
      if (step.op !== 'drag') {
        if (step.op === 'click') await conn.clickByNodeId(control.backendDOMNodeId)
        else if (step.op === 'type') await conn.fillByNodeId(control.backendDOMNodeId, step.isPassword ? secret! : step.value ?? '')
        else await conn.selectOption(control.backendDOMNodeId, step.value ?? '')
      } else {
        const to = step.to
        const dest = !to ? undefined : 'role' in to ? await find(to, false) : await findTestId(to.testid)
        if (to && !dest) {
          const label = 'role' in to ? describe(to) : `testid=${to.testid}`
          return { ok: true, data: `STALE: step ${i + 1}/${script.steps.length} drag target ${label} not found · ${elapsed()}` }
        }
        const from = await conn.getBoxCenter(control.backendDOMNodeId)
        const box = dest ? await conn.getBoxRect(dest.backendDOMNodeId, { scrollIntoView: false }) : await viewportBox(conn)
        await conn.dragBetweenPositions(from, edgePoint(box, step.edge), { mode: 'pointer' })
      }
    } catch (err) {
      // The window reloaded under the action (login, logout): it went out; the next poll reconnects.
      // Any other failure means the control vanished between finding and acting (a panel
      // that toggled shut): the app is not in the state the script was recorded in.
      if (!isDeadSocket(err)) {
        const reason = err instanceof Error ? err.message : String(err)
        return { ok: true, data: `STALE: step ${i + 1}/${script.steps.length} ${step.op} ${describe(step.target)} — ${reason} · ${elapsed()}` }
      }
    }
  }

  // Split the total: our steps vs the app answering them (auth, reload) — only the first is ours to speed up.
  const stepsTime = elapsed()
  const until = locatorFromArgs({ ...script.until, testIdAttribute })
  if (!until) return { ok: true, data: `DONE: replay ${name} · ${script.steps.length} steps · ${elapsed()} (no until saved)` }
  const isMet = await poll(async c => ('error' in await findByLocator(c, until) ? undefined : true), UNTIL_TIMEOUT_MS)
  return {
    ok: true,
    data: isMet
      ? `DONE: replay ${name} · ${script.steps.length} steps · ${elapsed()} (steps ${stepsTime}, then waiting for ${until.label})`
      : `FAIL: replay ${name} — steps ran, ${until.label} not visible after ${UNTIL_TIMEOUT_MS / 1000}s · ${elapsed()}`,
  }
}
