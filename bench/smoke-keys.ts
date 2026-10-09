/**
 * Focused smoke: key presses over real CDP, against a real Electron window.
 *   1. `key` types a printable key into the focused input.
 *   2. `key --testid` aims a chord at a focus-scoped hotkey zone; the page sees the modifiers as keys held.
 *   3. `key --testid` aims a key at a pointer-scoped zone (scope set on mouseenter, as a canvas editor does).
 *   4. `act key` records a chord aimed at the pointer zone, and `act replay` runs it twice, the pointer
 *      moved away in between.
 *
 * The zones are added to the bench page by `eval`, so the page the token benchmark measures stays as it is.
 *
 * Run: npx tsx bench/smoke-keys.ts
 */

import { createConnection } from 'node:net'
import { mkdtempSync, readFile, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { AgentViewServer } from '../src/server/server.js'
import { SERVER_PORT, TOKEN_PATH } from '../src/server/port.js'
import { RuntimeType } from '../src/types.js'

const readFileP = promisify(readFile)
const __dirname = dirname(fileURLToPath(import.meta.url))
const BENCH_ELECTRON_PORT = 19222

type Resp = { ok: boolean; data?: unknown; error?: string; exitCode?: number }

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

const isCDPUp = (port: number): Promise<boolean> =>
  fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.ok, () => false)

async function waitForCDP(port: number): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (await isCDPUp(port)) return
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`CDP not reachable on ${port}`)
}

/** Stops whatever server holds the port first: a leftover one serves the code it was started with. */
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
  throw new Error(`port ${SERVER_PORT} stayed occupied`)
}

/**
 * A focusable zone, a pointer zone (active between mouseenter and mouseleave, focus not taken) and an
 * input. Every non-modifier keydown writes `<scope> <held keys>+<key>` to `#key-status`, the held
 * keys counted from their own keydown / keyup as hotkey libraries do.
 */
const FIXTURE = `(() => {
  document.getElementById('keys-fixture')?.remove();
  const box = document.createElement('section');
  box.id = 'keys-fixture';
  box.innerHTML = '<div id="focus-zone" data-testid="focus-zone" tabindex="0" style="height:60px;border:1px dashed">focus zone</div>'
    + '<div id="hover-zone" data-testid="hover-zone" style="height:60px;border:1px dashed">hover zone</div>'
    + '<input id="key-input" aria-label="Key input">'
    + '<p id="key-status" role="status">idle</p>';
  document.querySelector('main').prepend(box);
  const held = new Set();
  let isHovered = false;
  const hover = document.getElementById('hover-zone');
  hover.addEventListener('mouseenter', () => { isHovered = true });
  hover.addEventListener('mouseleave', () => { isHovered = false });
  document.addEventListener('keyup', e => held.delete(e.key));
  document.addEventListener('keydown', e => {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) { held.add(e.key); return }
    const scope = document.activeElement?.id === 'focus-zone' ? 'focus' : isHovered ? 'hover' : 'none';
    const status = document.getElementById('key-status');
    status.textContent = scope + ' ' + [...held, e.key].join('+');
    status.dataset.last = status.textContent;
  });
  return 'ok';
})()`

async function main(): Promise<void> {
  // A bench app already running (minimised, say) is reused and left running: the fixture needs no fresh page.
  const proc = await isCDPUp(BENCH_ELECTRON_PORT) ? undefined : spawnElectron()
  console.log(`[smoke] ${proc ? 'Spawning Electron' : 'Reusing the running bench app'} + starting agent-view server`)
  await waitForCDP(BENCH_ELECTRON_PORT)
  await ensureServer()

  const token = (await readFileP(TOKEN_PATH, 'utf8')).trim()
  const base = { token, runtime: RuntimeType.Electron, port: BENCH_ELECTRON_PORT }
  const appCwd = join(__dirname, 'app')
  // Outside any git checkout: the script store lands here, not in the repo.
  const storeCwd = mkdtempSync(join(tmpdir(), 'av-smoke-keys-'))

  const checks: Array<{ name: string; passed: boolean; detail: string }> = []
  const check = (name: string, passed: boolean, detail = ''): void => {
    checks.push({ name, passed, detail })
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  const evaluate = async (expression: string): Promise<string> => {
    const res = await sendCommand({ ...base, command: 'eval', args: { expression, cwd: appCwd } })
    if (!res.ok) return `ERROR: ${res.error ?? ''}`
    const { result } = res.data as { result: string }
    return result.replace(/^["'](.*)["']$/s, '$1')
  }
  const key = (keys: string, args: Record<string, unknown> = {}) => sendCommand({ ...base, command: 'key', args: { keys, ...args } })
  const act = (args: Record<string, unknown>) => sendCommand({ ...base, command: 'act', args: { ...args, cwd: storeCwd } }, 60_000)
  const status = () => evaluate(`document.getElementById('key-status').textContent`)
  const resetStatus = () => evaluate(`(() => { const s = document.getElementById('key-status'); s.textContent = 'idle'; delete s.dataset.last; return 'ok' })()`)

  try {
    if (proc) await new Promise(r => setTimeout(r, 1500))
    check('fixture added', await evaluate(FIXTURE) === 'ok')

    console.log('\n[smoke] key into the focused input')
    await evaluate(`document.getElementById('key-input').focus()`)
    const typed = await key('h i shift+1')
    check('key returns ok', typed.ok, typed.error ?? String(typed.data ?? ''))
    check('printable keys type into the focused input', await evaluate(`document.getElementById('key-input').value`) === 'hi!')

    console.log('\n[smoke] key --testid on a focus-scoped zone')
    const focused = await key('ctrl+shift+z', { testid: 'focus-zone' })
    check('key --testid returns ok', focused.ok, focused.error ?? String(focused.data ?? ''))
    const focusStatus = await status()
    check('the chord reaches the focus zone, modifiers held as keys', focusStatus === 'focus Control+Shift+Z', focusStatus)

    console.log('\n[smoke] key --testid on a pointer-scoped zone')
    await key('Escape', { testid: 'hover-zone' })
    const hoverStatus = await status()
    check('the pointer zone sees the key, focus left the focus zone', hoverStatus === 'hover Escape', hoverStatus)

    console.log('\n[smoke] act key recorded and replayed')
    await key('Tab', { testid: 'focus-zone' })
    await resetStatus()
    const until = '#key-status[data-last="hover Control+z"]'
    const started = await act({ op: 'start', untilSelector: until, save: 'undo-in-hover', in: 'keys' })
    check('act start returns ok', started.ok, started.error ?? '')
    const recorded = await act({ op: 'key', keys: 'ctrl+z', target: 'testid=hover-zone' })
    check('act key ends DONE and saves', recorded.ok && String(recorded.data).startsWith('DONE') && String(recorded.data).includes('saved'),
      recorded.error ?? String(recorded.data ?? '').split('\n')[0])
    for (const run of [1, 2]) {
      // The pointer and focus elsewhere, as after any other step: replay must aim the keys again.
      await key('Tab', { testid: 'focus-zone' })
      await resetStatus()
      const replayed = await act({ op: 'replay', name: 'undo-in-hover' })
      check(`act replay ${run} ends DONE`, replayed.ok && replayed.exitCode === 0, replayed.error ?? String(replayed.data ?? ''))
    }
  } finally {
    await sendCommand({ token, command: 'stop', args: {} } as Record<string, unknown>).catch(() => {})
    proc?.kill()
  }

  const passed = checks.filter(c => c.passed).length
  console.log(`\n[smoke] ${passed}/${checks.length} checks passed`)
  if (passed !== checks.length) process.exit(1)
}

main().catch((err: unknown) => {
  console.error('[smoke] FATAL:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
