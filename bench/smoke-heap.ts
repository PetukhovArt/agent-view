/**
 * Heap smoke: does `heap take → act → take → diff` name the class that grew,
 * and does `heap retainers` name what holds it?
 *
 * The leak is planted from inside the page: 200 `<div>`s are created, put in
 * the DOM, removed again and kept in a global array — the textbook detached
 * DOM node. The diff must show `Detached <div class="leaked-row">` growing by 200 and the
 * retainers must point at the array.
 *
 * Run: npx tsx bench/smoke-heap.ts
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

function sendCommand(req: Record<string, unknown>, timeoutMs = 60_000): Promise<Resp> {
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
  console.log('[smoke-heap] Spawning Electron + starting agent-view server')
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
  const heap = (args: Record<string, unknown>): Promise<Resp> =>
    sendCommand({ ...base, command: 'heap', args: { ...args, cwd } })
  const evalIn = (expression: string): Promise<Resp> =>
    sendCommand({ ...base, command: 'eval', args: { expression, cwd } })

  try {
    await new Promise(r => setTimeout(r, 1000))

    const noSnap = await heap({ action: 'diff' })
    check('diff before any take is refused with a recovery hint',
      !noSnap.ok && String(noSnap.error).includes('heap take'), noSnap.error ?? '')

    const t0 = Date.now()
    const baseline = await heap({ action: 'take', name: 'baseline' })
    const bTxt = String(baseline.data ?? baseline.error)
    console.log('  ' + bTxt + `  [${Date.now() - t0} ms]`)
    check('take returns the one-line summary', baseline.ok && /Snapshot "baseline" \(page:.*\): [\d,]+ nodes, .* detached DOM nodes/.test(bTxt), bTxt)

    const leaked = await evalIn(`
      window.__leak = [];
      for (let i = 0; i < 200; i++) {
        const d = document.createElement('div');
        d.className = 'leaked-row';
        document.body.appendChild(d);
        d.remove();
        window.__leak.push(d);
      }
      window.__leak.length
    `)
    check('planted 200 detached divs', leaked.ok, leaked.error ?? '')

    const target = await heap({ action: 'take', name: 'target' })
    console.log('  ' + String(target.data ?? target.error))
    check('second take ok', target.ok, target.error ?? '')

    const diff = await heap({ action: 'diff', detached: true })
    const dTxt = String(diff.data ?? diff.error)
    console.log('  --- diff --detached ---\n  ' + dTxt.slice(0, 800).replace(/\n/g, '\n  '))
    console.log('  -----------------------')
    check('diff names the detached div +200', diff.ok && /Detached <div class="leaked-row">\s+\+200\b/.test(dTxt), diff.error ?? '')
    check('diff header counts the detached growth', /detached \+200 /.test(dTxt))

    const retainers = await heap({ action: 'retainers', class: 'Detached <div class="leaked-row">', maxLines: 12 })
    const rTxt = String(retainers.data ?? retainers.error)
    console.log('  --- retainers ---\n  ' + rTxt.replace(/\n/g, '\n  '))
    console.log('  -----------------')
    check('retainers names the owning Array, not the backing store', retainers.ok && /^Array \[\]\s+200$/m.test(rTxt), retainers.error ?? '')

    const filtered = await heap({ action: 'summary', filter: 'Detached <div' })
    check('summary --filter narrows to the class', filtered.ok && String(filtered.data).includes('Detached <div class="leaked-row">'), filtered.error ?? '')

    const unknown = await heap({ action: 'retainers', class: 'ZzNoSuchClass' })
    check('unknown class is a valid empty answer', unknown.ok && String(unknown.data).startsWith('(no instances'), String(unknown.data ?? unknown.error))

    await evalIn('window.__leak = null')
    const final = await heap({ action: 'take', name: 'final' })
    check('third take ok', final.ok, final.error ?? '')
    const back = await heap({ action: 'diff', names: ['target', 'final'], detached: true })
    const backTxt = String(back.data ?? back.error)
    console.log('  --- diff target final --detached ---\n  ' + backTxt.slice(0, 400).replace(/\n/g, '\n  '))
    check('releasing the array frees the divs', back.ok && /Detached <div class="leaked-row">\s+-200\b/.test(backTxt), back.error ?? '')

    const list = await heap({ action: 'list' })
    check('list shows three snapshots', list.ok && String(list.data).split('\n').length === 3, String(list.data ?? list.error))
  } finally {
    await sendCommand({ token, command: 'stop', args: {} } as Record<string, unknown>).catch(() => {})
    proc.kill()
  }

  const passed = checks.filter(c => c.passed).length
  console.log(`\n[smoke-heap] ${passed}/${checks.length} checks passed`)
  if (passed !== checks.length) process.exit(1)
}

main().catch((err: unknown) => {
  console.error('[smoke-heap] FATAL:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
