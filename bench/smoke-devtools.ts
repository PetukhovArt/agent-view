/**
 * Focused smoke: can we read console logs from a page AND from a SharedWorker
 * via `agent-view console`? That's the only thing this script asserts.
 *
 * Run: npx tsx bench/smoke-devtools.ts
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
  const cwd = join(__dirname, 'app')

  const checks: Array<{ name: string; passed: boolean; detail: string }> = []
  const check = (name: string, passed: boolean, detail = ''): void => {
    checks.push({ name, passed, detail })
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  try {
    // Give SharedWorker time to register
    await new Promise(r => setTimeout(r, 1500))

    // ── Step 1: enumerate targets so we can find the SharedWorker id ──────────
    console.log('\n[smoke] discovering targets')
    const tgs = await sendCommand({ ...base, command: 'targets', args: {} })
    const targets = (tgs.data as { targets: Array<{ id: string; type: string; title: string; url: string }> }).targets
    console.log('  targets:')
    for (const t of targets) console.log(`    ${t.type.padEnd(15)} ${t.id.slice(0, 8)}  ${t.title || '(untitled)'}`)
    const sw = targets.find(t => t.type === 'shared_worker')
    check('targets includes a page', targets.some(t => t.type === 'page'))
    check('targets includes shared_worker', !!sw)

    // ── Step 2: prime attach for both targets BEFORE generating events ────────
    // `console` is lazy: it attaches on first call. Anything emitted before the
    // first call is lost. So we call it once to attach, then trigger events.
    console.log('\n[smoke] priming attach (first console call attaches all targets)')
    await sendCommand({ ...base, command: 'console', args: { cwd } })
    if (sw) await sendCommand({ ...base, command: 'console', args: { target: sw.id, cwd } })

    // ── Step 3: trigger logs in BOTH contexts via eval (deterministic, no UI race) ─
    console.log('\n[smoke] firing eval to trigger logs')
    await sendCommand({
      ...base, command: 'eval',
      args: { expression: `console.log('SMOKE_PAGE_LOG'); console.warn('Submit clicked via eval')`, cwd },
    })
    if (sw) {
      await sendCommand({
        ...base, command: 'eval',
        args: { target: sw.id, expression: `console.log('[bench-worker] message #SMOKE')`, cwd },
      })
    }
    // Let the events propagate through CDP → our subscription → ring buffer
    await new Promise(r => setTimeout(r, 800))

    // ── Step 4: page console — must contain warn from click handler ───────────
    console.log('\n[smoke] reading page console (after attach + click)')
    const pageConsole = await sendCommand({ ...base, command: 'console', args: { cwd } })
    const pageTxt = String(pageConsole.data ?? '')
    console.log('  --- page console output (first 500 chars) ---')
    console.log('  ' + pageTxt.slice(0, 500).replace(/\n/g, '\n  '))
    console.log('  ---------------------------------------------')
    check('page console returns ok', pageConsole.ok, pageConsole.error ?? '')
    check('page warn "Submit clicked" captured (live log after attach)',
      pageTxt.includes('Submit clicked'))

    // ── Step 5: shared_worker console — must contain log from postMessage handler ─
    console.log('\n[smoke] reading shared_worker console (after attach + postMessage)')
    if (!sw) {
      check('shared_worker console (skipped)', false, 'no worker target')
    } else {
      const swConsole = await sendCommand({
        ...base, command: 'console',
        args: { target: sw.id, cwd },
      })
      const swTxt = String(swConsole.data ?? '')
      console.log('  --- worker console output (first 500 chars) ---')
      console.log('  ' + swTxt.slice(0, 500).replace(/\n/g, '\n  '))
      console.log('  -----------------------------------------------')
      check('worker console returns ok', swConsole.ok, swConsole.error ?? '')
      check('worker log "[bench-worker] message #" captured',
        swTxt.includes('[bench-worker] message #'))
    }
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
