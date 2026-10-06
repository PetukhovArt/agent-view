/**
 * Focused smoke: agent-view against a window in the background — covered by an
 * always-on-top window, minimised, or hidden — on Electron (bench/app) and on
 * Tauri (bench/tauri-app). Per window state it asserts:
 *   1. `eval`, `click --selector` (its handler runs once), `dom` and
 *      `click --filter` work without the window being drawn.
 *   2. `screenshot` works where the runtime still draws the window, and fails in
 *      under 2 s with the `Window is hidden` hint where it does not (Electron).
 *   3. No command brings the window forward: its visibility is the same after.
 *
 * The Tauri half needs `cargo build` in bench/tauri-app/src-tauri first; without
 * the exe it is skipped. Windows pop up and close during the run.
 *
 * Run: npx tsx bench/smoke-background.ts
 */

import { createConnection } from 'node:net'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { AgentViewServer } from '../src/server/server.js'
import { SERVER_PORT, TOKEN_PATH } from '../src/server/port.js'
import { RuntimeType } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(__dirname, 'app')
const TAURI_EXE = join(__dirname, 'tauri-app', 'src-tauri', 'target', 'debug', 'bench-tauri-app.exe')
const ELECTRON_CDP_PORT = 19222
const TAURI_CDP_PORT = 19224
const MODES = ['normal', 'occluded', 'minimized', 'hidden'] as const
const HIDDEN_SCREENSHOT_LIMIT_MS = 2_000

type Mode = typeof MODES[number]
type Resp = { ok: boolean; data?: unknown; error?: string }
type BenchApp = {
  runtime: RuntimeType
  cdpPort: number
  spawn: (mode: Mode) => ChildProcess
  isBenchPage: (url: string) => boolean
  /** Until the window has reached its state: the Tauri app minimises / hides 3 s after start. */
  settleMs: number
  /** Whether the runtime still draws the window in this state, so a screenshot can work. */
  isDrawn: (mode: Mode) => boolean
}

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
  throw new Error(`port ${SERVER_PORT} stayed occupied`)
}

async function waitForPage(app: BenchApp): Promise<string> {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${app.cdpPort}/json/list`)).json() as Array<{ id: string; url: string; type: string }>
      const page = list.find(t => t.type === 'page' && app.isBenchPage(t.url))
      if (page) return page.id
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`no bench page on CDP port ${app.cdpPort}`)
}

/** The Tauri app's WebView2 runs in child processes that a plain kill leaves behind. */
function killTree(proc: ChildProcess): void {
  if (process.platform !== 'win32') {
    proc.kill()
    return
  }
  try { execSync(`taskkill /T /F /PID ${proc.pid}`, { stdio: 'ignore' }) } catch { /* already gone */ }
}

const electronExe = (): string => {
  const electronDir = join(APP_DIR, 'node_modules', 'electron')
  return join(electronDir, 'dist', readFileSync(join(electronDir, 'path.txt'), 'utf8').trim())
}

const ELECTRON: BenchApp = {
  runtime: RuntimeType.Electron,
  cdpPort: ELECTRON_CDP_PORT,
  spawn: mode => spawn(electronExe(), ['main.js', `--remote-debugging-port=${ELECTRON_CDP_PORT}`], {
    cwd: APP_DIR,
    env: { ...process.env, BG_MODE: mode, BG_VARIANT: 'none' },
    stdio: 'ignore',
  }),
  isBenchPage: url => url.startsWith('file:') && url.endsWith('index.html'),
  settleMs: 1_500,
  isDrawn: mode => mode === 'normal',
}

const TAURI: BenchApp = {
  runtime: RuntimeType.Tauri,
  cdpPort: TAURI_CDP_PORT,
  spawn: mode => spawn(TAURI_EXE, [], {
    env: {
      ...process.env,
      BG_MODE: mode,
      BG_VARIANT: 'none',
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${TAURI_CDP_PORT}`,
    },
    stdio: 'ignore',
  }),
  isBenchPage: url => url.startsWith('http://tauri.localhost'),
  settleMs: 4_500,
  isDrawn: () => true,
}

const checks: Array<{ name: string; passed: boolean }> = []
const check = (name: string, passed: boolean, detail = ''): void => {
  checks.push({ name, passed })
  console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

async function runMode(app: BenchApp, mode: Mode, token: string): Promise<void> {
  console.log(`\n[smoke-background] ${app.runtime} / ${mode}`)
  const proc = app.spawn(mode)
  try {
    const window = await waitForPage(app)
    await new Promise(r => setTimeout(r, app.settleMs))
    const send = (command: string, args: Record<string, unknown>): Promise<Resp> =>
      sendCommand({ token, runtime: app.runtime, port: app.cdpPort, command, args: { window, cwd: APP_DIR, ...args } })
        .catch((err: unknown) => ({ ok: false, error: String(err) }))
    const evaluate = async (expression: string): Promise<string> => {
      const res = await send('eval', { expression })
      if (!res.ok) return `ERROR: ${res.error ?? ''}`
      // `eval` prints strings quoted; the checks compare against the bare text.
      return (res.data as { result: string }).result.replace(/^["'](.*)["']$/s, '$1')
    }

    const visibleBefore = await evaluate('document.visibilityState')
    check('eval', !visibleBefore.startsWith('ERROR'), `visibilityState=${visibleBefore}`)

    await evaluate('window.__clicks = 0; document.getElementById("reset-btn").addEventListener("click", () => window.__clicks++); 1')
    const bySelector = await send('click', { selector: '#reset-btn' })
    const clicks = await evaluate('window.__clicks')
    check('click --selector runs the handler once', bySelector.ok && clicks === '1', bySelector.error ?? `clicks=${clicks}`)

    const dom = await send('dom', { count: true })
    check('dom', dom.ok, dom.error ?? '')

    const byFilter = await send('click', { filter: 'Reset' })
    check('click --filter', byFilter.ok, byFilter.error ?? '')

    const shotStart = Date.now()
    const shot = await send('screenshot', { scale: 0.2 })
    const shotMs = Date.now() - shotStart
    if (shot.ok) rmSync(String(shot.data), { force: true })
    if (app.isDrawn(mode)) {
      check('screenshot', shot.ok, shot.error ?? `${shotMs} ms`)
    } else {
      const isHintedFastFailure = !shot.ok && String(shot.error).includes('Window is hidden') && shotMs < HIDDEN_SCREENSHOT_LIMIT_MS
      check(`screenshot fails in under ${HIDDEN_SCREENSHOT_LIMIT_MS} ms with the hint`, isHintedFastFailure,
        `${shotMs} ms, ${shot.ok ? 'succeeded' : String(shot.error).slice(0, 60)}`)
    }

    const visibleAfter = await evaluate('document.visibilityState')
    check('window not brought forward', visibleAfter === visibleBefore, `${visibleBefore} -> ${visibleAfter}`)
  } catch (err: unknown) {
    check('setup', false, String(err))
  } finally {
    killTree(proc)
    // The next spawn reuses the CDP port, and the Electron app its network-smoke port.
    await new Promise(r => setTimeout(r, 1_500))
  }
}

async function main(): Promise<void> {
  await ensureServer()
  const token = readFileSync(TOKEN_PATH, 'utf8').trim()
  try {
    for (const mode of MODES) await runMode(ELECTRON, mode, token)
    if (existsSync(TAURI_EXE)) {
      for (const mode of MODES) await runMode(TAURI, mode, token)
    } else {
      console.log(`\n[smoke-background] SKIP Tauri: ${TAURI_EXE} not built (run \`cargo build\` in bench/tauri-app/src-tauri)`)
    }
  } finally {
    await sendCommand({ token, command: 'stop', args: {} } as Record<string, unknown>).catch(() => {})
  }

  const passed = checks.filter(c => c.passed).length
  console.log(`\n[smoke-background] ${passed}/${checks.length} checks passed`)
  if (passed !== checks.length) process.exit(1)
}

main().catch((err: unknown) => {
  console.error('[smoke-background] FATAL:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
