/**
 * Reachability smoke: can `coverage` attribute a click to the function it ran,
 * and can `listeners` name the file:line a handler was declared at?
 *
 * The bench app wires `#reset-btn` to an arrow that calls the named
 * `resetFeedback()` — so a click on "Reset" is the smallest end-to-end proof
 * that the precise-coverage delta reaches page code.
 *
 * The click is dispatched from inside the page rather than through
 * `agent-view click`: `click --filter` currently hangs against the bench app on
 * this machine, on clean HEAD too (`bench/run.ts` dies at `click_filter_cold`).
 * That is a separate, pre-existing failure; the event, the handler and the
 * coverage attribution are identical either way, so it is not worth coupling
 * this smoke to it.
 *
 * Run: npx tsx bench/smoke-reach.ts
 */

import { createConnection } from 'node:net'
import { readFile, readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { AgentViewServer } from '../src/server/server.js'
import { RuntimeType } from '../src/types.js'

const readFileP = promisify(readFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_PORT = 47922
const BENCH_ELECTRON_PORT = 19222
const TOKEN_PATH = join(homedir(), '.agent-view', 'token')

type Resp = { ok: boolean; data?: unknown; error?: string }

function sendCommand(req: Record<string, unknown>, timeoutMs = 15_000): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: SERVER_PORT })
    let buf = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Command timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'))
    socket.on('data', (chunk) => {
      buf += chunk.toString()
      if (buf.includes('\n')) {
        clearTimeout(timer)
        socket.destroy()
        try { resolve(JSON.parse(buf.trim()) as Resp) }
        catch { reject(new Error(`Invalid JSON response: ${buf}`)) }
      }
    })
    socket.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

function spawnElectron(): ChildProcess {
  const appDir = join(__dirname, 'app')
  const exeName = readFileSync(join(appDir, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()
  const electronBin = join(appDir, 'node_modules', 'electron', 'dist', exeName)
  return spawn(electronBin, ['main.js', `--remote-debugging-port=${BENCH_ELECTRON_PORT}`], {
    cwd: appDir, stdio: 'ignore', detached: false,
  })
}

async function waitForCDP(port: number): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`CDP not reachable on ${port}`)
}

/** A leftover server keeps serving the code it was started with — stop it first. */
async function ensureServer(): Promise<void> {
  await sendCommand({ command: 'stop', port: 0, runtime: RuntimeType.Electron, args: {}, token: '' }, 3_000)
    .catch(() => { /* nothing was listening */ })
  for (let i = 0; i < 20; i++) {
    const srv = new AgentViewServer()
    try { await srv.start(); return }
    catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      await new Promise(r => setTimeout(r, 200))
    }
  }
  throw new Error('port 47922 stayed occupied')
}

async function main(): Promise<void> {
  console.log('[smoke-reach] Spawning Electron + starting agent-view server')
  const proc = spawnElectron()
  await new Promise(r => setTimeout(r, 2000))
  await waitForCDP(BENCH_ELECTRON_PORT)
  await ensureServer()

  const token = (await readFileP(TOKEN_PATH, 'utf8')).trim()
  const cwd = join(__dirname, 'app')
  const base = { token, runtime: RuntimeType.Electron, port: BENCH_ELECTRON_PORT }

  const checks: Array<{ name: string; passed: boolean }> = []
  const check = (name: string, passed: boolean, detail = ''): void => {
    checks.push({ name, passed })
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }
  const cov = (args: Record<string, unknown>): Promise<Resp> =>
    sendCommand({ ...base, command: 'coverage', args: { ...args, cwd } })
  const clickReset = (): Promise<Resp> => sendCommand({
    ...base, command: 'eval',
    args: { expression: `document.getElementById('reset-btn').click()`, cwd },
  })

  try {
    await new Promise(r => setTimeout(r, 1000))

    // ── A take before any --clear is a usage error, not an empty result ────────
    const noWindow = await cov({})
    check('take without a window is refused with a recovery hint',
      !noWindow.ok && String(noWindow.error).includes('--clear'), noWindow.error ?? '')

    // ── Open a window, then close it with nothing in between ──────────────────
    const cleared = await cov({ clear: true })
    check('--clear opens a window', cleared.ok && cleared.data === 'Coverage window cleared', String(cleared.data ?? cleared.error))

    const idle = await cov({ filter: 'resetFeedback' })
    check('an idle window does not report the handler',
      idle.ok && String(idle.data) === '(no code matching "resetFeedback")', String(idle.data ?? idle.error))

    // ── clear → act → check: the click must be attributable ───────────────────
    await cov({ clear: true })
    const clicked = await clickReset()
    check('clicked Reset', clicked.ok, clicked.error ?? '')
    await new Promise(r => setTimeout(r, 300))

    const after = await cov({})
    const afterTxt = String(after.data ?? '')
    console.log('  --- coverage ---\n  ' + afterTxt.slice(0, 700).replace(/\n/g, '\n  '))
    console.log('  ----------------')
    check('coverage names the executed handler', after.ok && afterTxt.includes('resetFeedback'), after.error ?? '')
    check('coverage groups it under the page URL', afterTxt.includes('index.html'))

    // ── Filters and --count over a fresh window ───────────────────────────────
    await cov({ clear: true })
    await clickReset()
    await new Promise(r => setTimeout(r, 300))
    const counted = await cov({ count: true })
    check('--count returns a positive integer', counted.ok && Number(counted.data) > 0, String(counted.data ?? counted.error))

    await cov({ clear: true })
    await clickReset()
    await new Promise(r => setTimeout(r, 300))
    const missed = await cov({ filter: 'zzNoSuchFunction' })
    check('an unmatched filter is a valid answer, not an error',
      missed.ok && String(missed.data) === '(no code matching "zzNoSuchFunction")', String(missed.data ?? missed.error))

    // ── listeners ─────────────────────────────────────────────────────────────
    const listeners = await sendCommand({ ...base, command: 'listeners', args: { filter: 'Reset', cwd } })
    const lTxt = String(listeners.data ?? '')
    console.log('  --- listeners ---\n  ' + lTxt.slice(0, 500).replace(/\n/g, '\n  '))
    console.log('  -----------------')
    check('listeners returns ok', listeners.ok, listeners.error ?? '')
    check('listeners reports the click handler', lTxt.includes('click'))
    check('listeners resolves the scriptId to a file:line', /index\.html:\d+:\d+/.test(lTxt))

    const missing = await sendCommand({ ...base, command: 'listeners', args: { filter: 'zzNoSuchElement', cwd } })
    check('an unmatched node is an error with the standard text',
      !missing.ok && String(missing.error).includes('No element found matching'), missing.error ?? '')

    // `#hidden-file` is display:none, so it has no [ref=N] — the case --selector exists for.
    const bySelector = await sendCommand({ ...base, command: 'listeners', args: { selector: '#hidden-file', cwd } })
    const sTxt = String(bySelector.data ?? '')
    check('--selector reaches a node the AX tree never exposes',
      bySelector.ok && sTxt.includes('change'), bySelector.error ?? sTxt)
    const badSelector = await sendCommand({ ...base, command: 'listeners', args: { selector: '#zzNoSuchId', cwd } })
    check('a selector matching nothing is an error',
      !badSelector.ok && String(badSelector.error).includes('No element matches selector'), badSelector.error ?? '')

    // ── Regression: the Debugger scan must not break a later eval or dom ───────
    const dom = await sendCommand({ ...base, command: 'dom', args: { filter: 'Reset', cwd } })
    check('dom still works after the scriptId scan', dom.ok && String(dom.data).includes('Reset'), dom.error ?? '')
  } finally {
    await sendCommand({ token, command: 'stop', args: {} } as Record<string, unknown>).catch(() => {})
    proc.kill()
  }

  const passed = checks.filter(c => c.passed).length
  console.log(`\n[smoke-reach] ${passed}/${checks.length} checks passed`)
  if (passed !== checks.length) process.exit(1)
}

main().catch((err: unknown) => {
  console.error('[smoke-reach] FATAL:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
