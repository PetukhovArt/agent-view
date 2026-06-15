/**
 * Network-capture smoke: does `agent-view network` capture real page-load traffic
 * (XHR/fetch, a 404, and a WebSocket frame exchange) end-to-end over CDP?
 *
 * Harness note: the bench spawns Electron directly (not via `agent-view launch`),
 * so the very first page-load happens before the server attaches. To test page-load
 * capture deterministically, we attach first, then `location.reload()` — the reload's
 * page-load traffic fires entirely inside the attached window. That exercises the
 * subscribe-before-enable ordering (a regression there would drop these requests).
 *
 * Run: npx tsx bench/smoke-network.ts
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

async function ensureServer(): Promise<void> {
  const srv = new AgentViewServer()
  try { await srv.start() }
  catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
  }
}

function refForWebSocket(listText: string): number | null {
  for (const line of listText.split('\n')) {
    if (line.includes('websocket')) {
      const m = /\[req=(\d+)\]/.exec(line)
      if (m) return Number(m[1])
    }
  }
  return null
}

async function main(): Promise<void> {
  console.log('[smoke-net] Spawning Electron + starting agent-view server')
  const proc = spawnElectron()
  await new Promise(r => setTimeout(r, 2000))
  await waitForCDP(BENCH_ELECTRON_PORT)
  await ensureServer()

  const token = (await readFileP(TOKEN_PATH, 'utf8')).trim()
  const cwd = join(__dirname, 'app')
  const base = {
    token,
    runtime: RuntimeType.Electron,
    port: BENCH_ELECTRON_PORT,
    args: {} as Record<string, unknown>,
  }

  const checks: Array<{ name: string; passed: boolean; detail: string }> = []
  const check = (name: string, passed: boolean, detail = ''): void => {
    checks.push({ name, passed, detail })
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  try {
    await new Promise(r => setTimeout(r, 1000))

    // ── Step 1: first `network` call attaches capture (subscribe-before-enable) ──
    console.log('\n[smoke-net] attaching capture (first network call)')
    const attachResp = await sendCommand({ ...base, command: 'network', args: { cwd } })
    check('network returns ok on first call', attachResp.ok, attachResp.error ?? '')

    // ── Step 2: reload so page-load traffic fires inside the attached window ─────
    console.log('[smoke-net] reloading page under active capture')
    await sendCommand({
      ...base, command: 'eval',
      args: { expression: '(() => { location.reload(); return "reload-triggered" })()', cwd },
    })
    await new Promise(r => setTimeout(r, 2500))

    // ── Step 3: list — page-load fetch + 404 must be captured passively ─────────
    console.log('\n[smoke-net] listing captured requests')
    const listResp = await sendCommand({ ...base, command: 'network', args: { cwd } })
    const listTxt = String(listResp.data ?? '')
    console.log('  --- network list ---\n  ' + listTxt.slice(0, 800).replace(/\n/g, '\n  '))
    console.log('  --------------------')
    check('list returns ok', listResp.ok, listResp.error ?? '')
    check('page-load /api/bootstrap captured', listTxt.includes('/api/bootstrap'))
    check('bootstrap shows status 200', /200\b.*\/api\/bootstrap/.test(listTxt) || /\/api\/bootstrap.*\b200/.test(listTxt) || listTxt.includes(' 200 '))
    check('failing /api/missing captured', listTxt.includes('/api/missing'))
    check('404 captured', listTxt.includes('404'))
    check('websocket connection captured', listTxt.includes('websocket'))

    // ── Step 4: status filter isolates the 404 ──────────────────────────────────
    console.log('\n[smoke-net] filtering --status 4xx')
    const failResp = await sendCommand({ ...base, command: 'network', args: { status: ['4xx'], cwd } })
    const failTxt = String(failResp.data ?? '')
    check('status 4xx filter shows /api/missing', failTxt.includes('/api/missing'))
    check('status 4xx filter hides /api/bootstrap', !failTxt.includes('/api/bootstrap'))

    // ── Step 5: url glob filter ─────────────────────────────────────────────────
    console.log('[smoke-net] filtering --url *bootstrap*')
    const urlResp = await sendCommand({ ...base, command: 'network', args: { url: '*bootstrap*', cwd } })
    const urlTxt = String(urlResp.data ?? '')
    check('url glob isolates bootstrap', urlTxt.includes('/api/bootstrap') && !urlTxt.includes('/api/missing'))

    // ── Step 6: WS frame log via --req ──────────────────────────────────────────
    // Refs are reallocated on every list call (DOM-ref semantics), so re-list first.
    console.log('\n[smoke-net] expanding the websocket connection')
    const freshList = String((await sendCommand({ ...base, command: 'network', args: { cwd } })).data ?? '')
    const wsRef = refForWebSocket(freshList)
    if (wsRef === null) {
      check('found a [req=N] handle for the websocket', false, 'no websocket line')
    } else {
      const detailResp = await sendCommand({ ...base, command: 'network', args: { req: wsRef, cwd } })
      const detailTxt = String(detailResp.data ?? '')
      console.log('  --- ws detail ---\n  ' + detailTxt.slice(0, 600).replace(/\n/g, '\n  '))
      console.log('  -----------------')
      check('ws detail returns ok', detailResp.ok, detailResp.error ?? '')
      check('ws frame log shows a received frame (↓)', detailTxt.includes('↓'))
      check('ws frame log shows a sent frame (↑)', detailTxt.includes('↑'))
      check('ws echo payload visible', detailTxt.includes('PING_FROM_PAGE') || detailTxt.includes('echo:') || detailTxt.includes('WELCOME_FROM_SERVER'))
    }
  } finally {
    await sendCommand({ token, command: 'stop', args: {} } as Record<string, unknown>).catch(() => {})
    proc.kill()
  }

  const passed = checks.filter(c => c.passed).length
  console.log(`\n[smoke-net] ${passed}/${checks.length} checks passed`)
  if (passed !== checks.length) process.exit(1)
}

main().catch((err: unknown) => {
  console.error('[smoke-net] FATAL:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
