import { createConnection } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import { AgentViewServer } from '../src/server/server.js'
import { RuntimeType } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SERVER_PORT = 47922
const BENCH_ELECTRON_PORT = 19222
const TOKEN_PATH = join(homedir(), '.agent-view', 'token')
const RESULTS_PATH = join(__dirname, 'results.json')
const BASELINE_PATH = join(__dirname, 'baseline.json')
const N = 10

type ScenarioResult = { median: number; p95: number; samples: number[] }
type BenchResults = Record<string, ScenarioResult>

// ── TCP send helper ────────────────────────────────────────────────────────────

function sendCommand(
  req: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: SERVER_PORT })
    let buf = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`Command timed out after ${timeoutMs}ms`))
    }, timeoutMs)

    socket.on('connect', () => {
      socket.write(JSON.stringify(req) + '\n')
    })
    socket.on('data', (chunk) => {
      buf += chunk.toString()
      if (buf.includes('\n')) {
        clearTimeout(timer)
        socket.destroy()
        try {
          resolve(JSON.parse(buf.trim()) as Record<string, unknown>)
        } catch {
          reject(new Error(`Invalid JSON response: ${buf}`))
        }
      }
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

// ── Stats ──────────────────────────────────────────────────────────────────────

function stats(samples: number[]): ScenarioResult {
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]
  return { median: Math.round(median), p95: Math.round(p95), samples }
}

// ── Electron spawn + wait for CDP ─────────────────────────────────────────────

function resolveElectronBin(appDir: string): string {
  // The electron package stores the binary name in path.txt; the binary lives in dist/
  const pathTxt = join(appDir, 'node_modules', 'electron', 'path.txt')
  try {
    const exeName = readFileSync(pathTxt, 'utf8').trim()
    return join(appDir, 'node_modules', 'electron', 'dist', exeName)
  } catch {
    throw new Error(`Could not read electron path from ${pathTxt}. Run: cd bench/app && npm install`)
  }
}

function spawnElectron(): ChildProcess {
  const appDir = join(__dirname, 'app')
  const electronBin = resolveElectronBin(appDir)
  const proc = spawn(electronBin, ['main.js', `--remote-debugging-port=${BENCH_ELECTRON_PORT}`], {
    cwd: appDir,
    stdio: 'ignore',
    detached: false,
  })
  proc.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      console.error('[bench] Electron binary not found at:', electronBin)
    } else {
      console.error('[bench] Electron spawn error:', err.message)
    }
    process.exit(1)
  })
  return proc
}

async function waitForCDP(port: number, retries = 30, delayMs = 500): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise<void>((r) => setTimeout(r, delayMs))
  }
  throw new Error(`CDP not reachable on port ${port} after ${retries * delayMs}ms`)
}

// ── Server start ──────────────────────────────────────────────────────────────

async function ensureServer(): Promise<void> {
  const srv = new AgentViewServer()
  try {
    await srv.start()
    console.log('[bench] Started AgentViewServer in-process')
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EADDRINUSE') {
      console.log('[bench] AgentViewServer already running — using existing instance')
    } else {
      throw err
    }
  }
}

// ── Base request factory ──────────────────────────────────────────────────────

async function makeBase() {
  const token = await readFile(TOKEN_PATH, 'utf8')
  return {
    token: token.trim(),
    runtime: RuntimeType.Electron,
    port: BENCH_ELECTRON_PORT,
    args: {},
  }
}

// ── Scenario runners ──────────────────────────────────────────────────────────

async function runN(label: string, fn: () => Promise<void>): Promise<ScenarioResult> {
  const samples: number[] = []
  for (let i = 0; i < N; i++) {
    const t0 = performance.now()
    await fn()
    samples.push(performance.now() - t0)
  }
  const result = stats(samples)
  console.log(`  ${label.padEnd(24)} median=${result.median}ms  p95=${result.p95}ms`)
  return result
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('[bench] Starting benchmark suite\n')

  const electronProc = spawnElectron()

  // Give Electron time to start, then wait for CDP
  await new Promise<void>((r) => setTimeout(r, 2000))
  console.log('[bench] Waiting for Electron CDP...')
  await waitForCDP(BENCH_ELECTRON_PORT)
  console.log('[bench] Electron ready\n')

  await ensureServer()

  const base = await makeBase()
  const results: BenchResults = {}

  console.log('[bench] Running scenarios (N=' + N + ' each)\n')

  // dom_cold: fresh full tree fetch each time (connection is warm after first call)
  results['dom_cold'] = await runN('dom_cold', async () => {
    await sendCommand({ ...base, command: 'dom', args: {} })
  })

  // dom_warm: rapid re-fetch — baseline has no cache, post-opt measures cache hit
  results['dom_warm'] = await runN('dom_warm', async () => {
    await sendCommand({ ...base, command: 'dom', args: {} })
    await sendCommand({ ...base, command: 'dom', args: {} })
  })
  // Subtract dom_cold median to isolate second call cost
  const dom_warm_samples = results['dom_warm'].samples.map(
    (s) => Math.max(0, s - (results['dom_cold'].median)),
  )
  results['dom_warm_second'] = stats(dom_warm_samples)
  console.log(
    `  ${'dom_warm_second'.padEnd(24)} median=${results['dom_warm_second'].median}ms  p95=${results['dom_warm_second'].p95}ms  (2nd call isolated)`,
  )

  // click_filter_cold: find "Button 10" and click it
  results['click_filter_cold'] = await runN('click_filter_cold', async () => {
    await sendCommand({ ...base, command: 'click', args: { filter: 'Button 10' } })
  })

  // click_filter_warm: two rapid filter clicks — second benefits from cache
  results['click_filter_warm'] = await runN('click_filter_warm', async () => {
    await sendCommand({ ...base, command: 'click', args: { filter: 'Button 10' } })
    await sendCommand({ ...base, command: 'click', args: { filter: 'Button 10' } })
  })
  const click_warm_samples = results['click_filter_warm'].samples.map(
    (s) => Math.max(0, s - (results['click_filter_cold'].median)),
  )
  results['click_filter_warm_second'] = stats(click_warm_samples)
  console.log(
    `  ${'click_filter_warm_second'.padEnd(24)} median=${results['click_filter_warm_second'].median}ms  p95=${results['click_filter_warm_second'].p95}ms  (2nd call isolated)`,
  )

  // fill_filter_cold: find "Input 5" and fill it
  results['fill_filter_cold'] = await runN('fill_filter_cold', async () => {
    await sendCommand({ ...base, command: 'fill', args: { filter: 'Input 5', value: 'test' } })
  })

  // wait_match: measures wait command overhead when element is present.
  // The Async Button appears 1500ms after page load; by the time we run this
  // scenario (~10-20s into the benchmark) the element is already there.
  // This measures the floor cost of a wait that resolves on first poll.
  results['wait_match'] = await runN('wait_match', async () => {
    await sendCommand({ ...base, command: 'wait', args: { filter: 'Async Button' } }, 10_000)
  })

  // cycle_dom_click_dom: full agent verification cycle
  results['cycle_dom_click_dom'] = await runN('cycle_dom_click_dom', async () => {
    await sendCommand({ ...base, command: 'dom', args: {} })
    await sendCommand({ ...base, command: 'click', args: { filter: 'Button 5' } })
    await sendCommand({ ...base, command: 'dom', args: {} })
  })

  // ── Write results ────────────────────────────────────────────────────────────

  const output = {
    timestamp: new Date().toISOString(),
    n: N,
    scenarios: results,
  }
  await writeFile(RESULTS_PATH, JSON.stringify(output, null, 2))
  console.log(`\n[bench] Results written to bench/results.json`)

  // ── Delta vs baseline ────────────────────────────────────────────────────────

  try {
    const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8')) as typeof output
    console.log('\n[bench] Delta vs baseline:\n')
    for (const [key, cur] of Object.entries(results)) {
      const base_ = baseline.scenarios[key]
      if (!base_) continue
      const delta = cur.median - base_.median
      const sign = delta <= 0 ? '' : '+'
      const pct = base_.median > 0 ? Math.round((delta / base_.median) * 100) : 0
      const flag = delta <= 0 ? '✓' : '△'
      console.log(`  ${flag} ${key.padEnd(28)} ${sign}${delta}ms (${sign}${pct}%)`)
    }
  } catch {
    console.log('\n[bench] No baseline.json found — run again after committing to compare.')
  }

  electronProc.kill()
  process.exit(0)
}

main().catch((err) => {
  console.error('[bench] Fatal:', err)
  process.exit(1)
})
