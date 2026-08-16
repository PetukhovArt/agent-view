/**
 * Focused smoke: modal handling. Four things it asserts, all against a real
 * Electron window:
 *   1. `alert()` does not freeze the renderer (Page domain is enabled, so an
 *      unanswered dialog would hang the page forever).
 *   2. `dialog policy` decides what `confirm()` returns.
 *   3. `upload --selector` fills a hidden file input.
 *   4. `dialog arm` answers a chooser opened by an input that is created and
 *      removed inside the click handler.
 *
 * Nothing here clicks a picker while nothing is armed — that would open a real
 * OS dialog and wedge the run.
 *
 * Run: npx tsx bench/smoke-dialogs.ts
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
  const pathTxt = join(appDir, 'node_modules', 'electron', 'path.txt')
  const exeName = readFileSync(pathTxt, 'utf8').trim()
  const electronBin = join(appDir, 'node_modules', 'electron', 'dist', exeName)
  return spawn(electronBin, ['main.js', `--remote-debugging-port=${BENCH_ELECTRON_PORT}`], {
    cwd: appDir,
    stdio: 'ignore',
    detached: false,
  })
}

async function waitForCDP(port: number): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`CDP not reachable on ${port}`)
}

/**
 * Stops whatever server holds the port first. A server left over from an
 * earlier run keeps serving the code it was started with, and the run then
 * reports failures that the current source does not have.
 */
async function ensureServer(): Promise<void> {
  await sendCommand({ command: 'stop', port: 0, runtime: RuntimeType.Electron, args: {}, token: '' }, 3_000)
    .catch(() => { /* nothing was listening */ })
  for (let i = 0; i < 20; i++) {
    const srv = new AgentViewServer()
    try {
      await srv.start()
      return
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      await new Promise(r => setTimeout(r, 200))
    }
  }
  throw new Error('port 47922 stayed occupied')
}

async function main(): Promise<void> {
  console.log('[smoke] Spawning Electron + starting agent-view server')
  const proc = spawnElectron()
  await new Promise(r => setTimeout(r, 2000))
  await waitForCDP(BENCH_ELECTRON_PORT)
  await ensureServer()

  const token = (await readFileP(TOKEN_PATH, 'utf8')).trim()
  const base = {
    token,
    runtime: RuntimeType.Electron,
    port: BENCH_ELECTRON_PORT,
    args: {} as Record<string, unknown>,
  }
  const appCwd = join(__dirname, 'app')
  const fixture = (name: string): string => join(__dirname, 'fixtures', name)

  const checks: Array<{ name: string; passed: boolean; detail: string }> = []
  const check = (name: string, passed: boolean, detail = ''): void => {
    checks.push({ name, passed, detail })
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  const evaluate = async (expression: string): Promise<string> => {
    const res = await sendCommand({ ...base, command: 'eval', args: { expression, cwd: appCwd } })
    if (!res.ok) return `ERROR: ${res.error ?? ''}`
    const { result } = res.data as { result: string }
    // `eval` prints strings quoted; the checks compare against the bare text.
    return result.replace(/^["'](.*)["']$/s, '$1')
  }

  /**
   * Clicks through CDP input, then polls the status line.
   *
   * It has to be a real CDP click: Chromium refuses to open a file chooser
   * without user activation, and an `eval`-driven `.click()` carries none — the
   * chooser is silently dropped and nothing is ever intercepted.
   */
  const clickAndAwait = async (id: string, expected: string): Promise<string> => {
    await evaluate(`document.getElementById('modal-status').textContent = 'idle'`)
    // By position, not by --filter: `Accessibility.queryAXTree` hangs on this
    // Electron build, and that is a separate problem from the one under test.
    const box = await evaluate(
      `(() => { const el = document.getElementById('${id}');`
      + ` el.scrollIntoView({ block: 'center' });`
      + ` const r = el.getBoundingClientRect();`
      + ` return Math.round(r.left + r.width / 2) + ',' + Math.round(r.top + r.height / 2) })()`,
    )
    if (box.startsWith('ERROR')) return box
    const [x, y] = box.split(',').map(Number)
    // Generous: a click whose handler opens a modal only acknowledges once the
    // modal is answered, so this call carries the whole round trip.
    const clicked = await sendCommand({ ...base, command: 'click', args: { pos: { x, y } } }, 40_000)
    if (!clicked.ok) return `ERROR: click "${id}": ${clicked.error ?? ''}`
    let last = 'idle'
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 250))
      last = await evaluate(`document.getElementById('modal-status').textContent`)
      if (last.startsWith('ERROR')) return last
      if (last.startsWith(expected)) return last
    }
    return `(no "${expected}" after 5s; status is "${last}")`
  }

  try {
    await new Promise(r => setTimeout(r, 1500))

    // ── 1. alert() must not freeze the renderer ───────────────────────────────
    console.log('\n[smoke] alert() with the default policy')
    const afterAlert = await clickAndAwait('alert-btn', 'alert returned')
    check('alert() returns — renderer not frozen', afterAlert === 'alert returned', afterAlert)

    const status1 = await sendCommand({ ...base, command: 'dialog', args: { action: 'status' } })
    const statusTxt1 = String(status1.data ?? '')
    check('dialog status logs the auto-dismissed alert',
      statusTxt1.includes('alert') && statusTxt1.includes('dismissed (auto)'), statusTxt1.split('\n')[1] ?? '')

    // ── 2. policy decides what confirm()/prompt() return ──────────────────────
    console.log('\n[smoke] confirm()/prompt() under each policy')
    const confirmDismissed = await clickAndAwait('confirm-btn', 'confirm=')
    check('confirm() is false under the dismiss default', confirmDismissed === 'confirm=false', confirmDismissed)

    await sendCommand({ ...base, command: 'dialog', args: { action: 'policy', mode: 'accept' } })
    const confirmAccepted = await clickAndAwait('confirm-btn', 'confirm=')
    check('confirm() is true under the accept policy', confirmAccepted === 'confirm=true', confirmAccepted)

    // No prompt() check here: Electron does not implement it at all — the call
    // throws "prompt() is not supported." before any dialog can open. The
    // promptText policy is exercised by the unit tests and applies to Tauri and
    // browser runtimes.

    await sendCommand({ ...base, command: 'dialog', args: { action: 'policy', mode: 'dismiss' } })

    // ── 3. upload into a hidden input, no chooser at all ──────────────────────
    console.log('\n[smoke] upload --selector into a hidden input')
    await evaluate(`document.getElementById('modal-status').textContent = 'idle'`)
    const upload = await sendCommand({
      ...base, command: 'upload',
      args: { selector: '#hidden-file', files: [fixture('upload-a.txt'), fixture('upload-b.txt')], cwd: appCwd },
    })
    check('upload --selector returns ok', upload.ok, upload.error ?? String(upload.data ?? ''))
    await new Promise(r => setTimeout(r, 400))
    const uploaded = await evaluate(`document.getElementById('modal-status').textContent`)
    check('hidden input received both files', uploaded === 'hidden-file=upload-a.txt,upload-b.txt', uploaded)

    // ── 4. armed chooser answers an input that only exists mid-click ──────────
    console.log('\n[smoke] dialog arm + dynamically created input')
    const armed = await sendCommand({
      ...base, command: 'dialog',
      args: { action: 'arm', files: [fixture('upload-a.txt')], cwd: appCwd },
    })
    check('dialog arm returns ok', armed.ok, armed.error ?? String(armed.data ?? ''))
    const dynamicFile = await clickAndAwait('dynamic-pick-btn', 'dynamic-file=')
    check('dynamic input received the armed file', dynamicFile === 'dynamic-file=upload-a.txt', dynamicFile)

    console.log('\n[smoke] dialog arm --cancel')
    const armedCancel = await sendCommand({ ...base, command: 'dialog', args: { action: 'arm', cancel: true, cwd: appCwd } })
    check('dialog arm --cancel returns ok', armedCancel.ok, armedCancel.error ?? '')
    const cancelled = await clickAndAwait('dynamic-pick-btn', 'dynamic-cancel')
    check('cancel reaches the page as input.oncancel', cancelled === 'dynamic-cancel', cancelled)

    // ── 5. arming is one-shot and leaves nothing behind ───────────────────────
    const finalStatus = await sendCommand({ ...base, command: 'dialog', args: { action: 'status' } })
    const finalTxt = String(finalStatus.data ?? '')
    console.log('\n  --- dialog status ---')
    console.log('  ' + finalTxt.replace(/\n/g, '\n  '))
    console.log('  ---------------------')
    check('arm is spent after firing', finalTxt.includes('File chooser (CDP): not armed'), finalTxt)

    await sendCommand({ ...base, command: 'dialog', args: { action: 'disarm', cwd: appCwd } })
  } finally {
    await sendCommand({ token, command: 'stop', args: {} } as Record<string, unknown>).catch(() => {})
    proc.kill()
  }

  const passed = checks.filter(c => c.passed).length
  console.log(`\n[smoke] ${passed}/${checks.length} checks passed`)
  if (passed !== checks.length) process.exit(1)
}

main().catch((err: unknown) => {
  console.error('[smoke] FATAL:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
