/**
 * Cesium smoke: `scene`, `click --scene`, `scene --goto` and act `scene=` / `goto` against
 * bench/cesium-app, on both its pages: vue-cesium (index) and plain CesiumJS (plain).
 * The app's own ScreenSpaceEventHandler records what each click picked in `window.__hits`.
 *
 * Starts its own server in-process: run beside a live one with a free port,
 * `AGENT_VIEW_SERVER_PORT=47931 npx tsx bench/smoke-cesium.ts`.
 */

import { createConnection } from 'node:net'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import CDP from 'chrome-remote-interface'
import { AgentViewServer } from '../src/server/server.js'
import { SERVER_PORT, TOKEN_PATH } from '../src/server/port.js'
import { RuntimeType, WebGLEngine } from '../src/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP_DIR = join(__dirname, 'cesium-app')
const CDP_PORT = 19223
const TARGET = 'Канал 3'
const FAR = 'За глобусом'

type Resp = { ok: boolean; data?: unknown; error?: string; exitCode?: number }
type Hit = { button: string; id: string | null; name: string | null }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function sendCommand(req: Record<string, unknown>, timeoutMs = 30_000): Promise<Resp> {
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

const isCdpUp = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(r => r.ok, () => false)

async function waitForMap(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then(r => r.json() as Promise<{ type: string; url: string }[]>, () => [])
    if (targets.some(t => t.type === 'page' && t.url.includes('localhost:5199'))) return
    await sleep(500)
  }
  throw new Error(`no app page on CDP ${CDP_PORT}`)
}

/** Vite may rebuild its deps on the first load, so the viewer comes up a while after the page. */
async function waitForViewer(run: (command: string, args: Record<string, unknown>) => Promise<Resp>): Promise<void> {
  for (let i = 0; i < 60; i++) {
    if (String((await run('scene', {})).data ?? '').startsWith('Viewer')) return
    await sleep(500)
  }
  throw new Error('no Cesium viewer on the page')
}

/** The tree: start.mjs runs vite and Electron as children, which a plain kill leaves behind on Windows. */
function killTree(proc: ChildProcess): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
  else proc.kill()
}

async function startServer(): Promise<void> {
  // Only ever the port this run owns: AGENT_VIEW_SERVER_PORT keeps a live server on 47922 out of it.
  await sendCommand({ command: 'stop', port: 0, runtime: RuntimeType.Electron, args: {}, token: '' }, 3_000).catch(() => {})
  for (let i = 0; i < 20; i++) {
    try { await new AgentViewServer().start(); return }
    catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      await sleep(200)
    }
  }
  throw new Error(`port ${SERVER_PORT} stayed occupied`)
}

/**
 * Shrinks the page viewport, as a window resize does: Electron has no `Browser.setWindowBounds`.
 * The override lasts while the returned client stays open.
 */
async function resizeViewport(width: number, height: number): Promise<CDP.Client> {
  const page = (await CDP.List({ port: CDP_PORT })).find(t => t.type === 'page')!
  const client = await CDP({ port: CDP_PORT, target: page.id })
  await client.Emulation.setDeviceMetricsOverride({ width, height, deviceScaleFactor: 0, mobile: false })
  return client
}

/** `plain.html?hook` sets `window.__CESIUM_VIEWER__ = { viewer, Cesium }`, which wins over catching frames. */
async function smokeHook(
  run: (command: string, args: Record<string, unknown>) => Promise<Resp>,
  hitAfter: (args: Record<string, unknown>) => Promise<{ clicked: Resp; hit: Hit | null }>,
  check: (name: string, passed: boolean, detail?: string) => void,
): Promise<void> {
  const page = (await CDP.List({ port: CDP_PORT })).find(t => t.type === 'page')!
  const client = await CDP({ port: CDP_PORT, target: page.id })
  await client.Page.navigate({ url: page.url.replace(/\?.*$/, '') + '?hook' })
  await client.close()
  await waitForViewer(run)
  const scene = await run('scene', {})
  check('[plain?hook] scene names via=hook', String(scene.data).includes('via=hook'), String(scene.data ?? scene.error).split('\n')[0])
  const left = await hitAfter({ scene: TARGET })
  check(`[plain?hook] click --scene "${TARGET}" hits it`, left.clicked.ok && left.hit?.name === TARGET,
    `${left.clicked.data ?? left.clicked.error} · ${JSON.stringify(left.hit)}`)
}

async function smokePage(page: 'index' | 'plain', token: string, check: (name: string, passed: boolean, detail?: string) => void): Promise<void> {
  const via = page === 'index' ? 'vue-cesium' : 'cesiumjs'
  const proc = spawn(process.execPath, ['start.mjs', ...(page === 'plain' ? ['--page=plain'] : [])], { cwd: APP_DIR, stdio: 'ignore' })
  const actDir = await mkdtemp(join(tmpdir(), 'smoke-cesium-'))
  try {
    await waitForMap()
    const base = { token, runtime: RuntimeType.Electron, port: CDP_PORT, engine: WebGLEngine.CesiumJS }
    const run = (command: string, args: Record<string, unknown>) => sendCommand({ ...base, command, args: { ...args, cwd: APP_DIR } })
    await waitForViewer(run)
    const evaluate = async (expression: string) => ((await run('eval', { expression })).data as { result: unknown }).result
    const lastHit = async () => JSON.parse(String(await evaluate('window.__hits.at(-1) ?? null'))) as Hit | null
    const hitAfter = async (args: Record<string, unknown>) => {
      await evaluate('window.__hits = []')
      const clicked = await run('click', args)
      await sleep(300)
      return { clicked, hit: await lastHit() }
    }
    const tag = `[${page}]`

    const scene = await run('scene', {})
    const sceneText = String(scene.data ?? scene.error)
    console.log(`  --- ${page} scene ---\n  ${sceneText.replace(/\n/g, '\n  ')}`)
    const targetLine = sceneText.split('\n').find(l => l.includes(`"${TARGET}"`)) ?? ''
    check(`${tag} scene lists "${TARGET}" at a point`, scene.ok && /\(\d+,\d+\)/.test(targetLine), targetLine)
    check(`${tag} scene names via=${via}`, sceneText.includes(`via=${via}`))

    const left = await hitAfter({ scene: TARGET })
    check(`${tag} click --scene "${TARGET}" hits it`, left.clicked.ok && left.hit?.button === 'left' && left.hit.name === TARGET,
      `${left.clicked.data ?? left.clicked.error} · ${JSON.stringify(left.hit)}`)

    const right = await hitAfter({ scene: 'cam-4', right: true })
    check(`${tag} click --scene cam-4 --right hits it`, right.clicked.ok && right.hit?.button === 'right' && right.hit.id === 'cam-4',
      `${right.clicked.data ?? right.clicked.error} · ${JSON.stringify(right.hit)}`)

    const resizer = await resizeViewport(900, 650)
    await sleep(1000)
    const resized = await hitAfter({ scene: TARGET })
    await resizer.Emulation.clearDeviceMetricsOverride()
    await resizer.close()
    await sleep(1000)
    check(`${tag} after a resize click --scene still hits`, resized.clicked.ok && resized.hit?.name === TARGET,
      `${resized.clicked.data ?? resized.clicked.error} · ${JSON.stringify(resized.hit)}`)
    check(`${tag} the point moved with the window`, String(resized.clicked.data) !== String(left.clicked.data), String(resized.clicked.data))

    const far = await run('click', { scene: FAR })
    check(`${tag} click --scene "${FAR}" is refused as covered`, !far.ok && far.error === `Scene object "${FAR}" is covered or off screen`, far.error ?? String(far.data))

    const missing = await run('click', { scene: 'Нет такого' })
    check(`${tag} an unknown object is refused`, !missing.ok && String(missing.error).startsWith('No scene object "Нет такого"'), missing.error ?? '')

    const gone = await run('scene', { goto: FAR })
    check(`${tag} scene --goto "${FAR}"`, gone.ok && String(gone.data).startsWith(`Camera over "${FAR}" (`), String(gone.data ?? gone.error))
    await sleep(500)
    const farHit = await hitAfter({ scene: FAR })
    check(`${tag} after --goto click --scene "${FAR}" hits it`, farHit.clicked.ok && farHit.hit?.name === FAR,
      `${farHit.clicked.data ?? farHit.clicked.error} · ${JSON.stringify(farHit.hit)}`)

    const home = await run('scene', { goto: '37.62,55.75,5000' })
    check(`${tag} scene --goto lon,lat,height`, home.ok && home.data === 'Camera over (37.6200, 55.7500) at 5000 m', String(home.data ?? home.error))

    // act: an until only the far-side click meets; its cwd allows eval and holds the script store.
    await copyFile(join(APP_DIR, 'agent-view.config.json'), join(actDir, 'agent-view.config.json'))
    const act = (args: Record<string, unknown>) => sendCommand({ ...base, command: 'act', args: { ...args, cwd: actDir } })
    const untilExpr = `window.__hits.some(h => h.name === ${JSON.stringify(FAR)})`
    await evaluate('window.__hits = []')
    const started = await act({ op: 'start', untilExpr })
    check(`${tag} act start`, started.ok, started.error ?? '')
    const actGoto = await act({ op: 'goto', place: FAR })
    check(`${tag} act goto`, actGoto.ok && String(actGoto.data).startsWith('✓ Camera over'), String(actGoto.data ?? actGoto.error).split('\n')[0])
    const actClick = await act({ op: 'click', target: `scene=${FAR}` })
    check(`${tag} act click scene=… reaches DONE`, actClick.ok && String(actClick.data).startsWith('DONE'), String(actClick.data ?? actClick.error).split('\n')[0])
    const saved = await act({ op: 'save', name: 'far-side', in: 'map' })
    check(`${tag} act save`, saved.ok, String(saved.data ?? saved.error))

    await run('scene', { goto: '37.62,55.75,5000' })
    await evaluate('window.__hits = []')
    const replayed = await act({ op: 'replay', name: 'far-side' })
    check(`${tag} act replay DONE`, replayed.ok && String(replayed.data).startsWith('DONE'), String(replayed.data ?? replayed.error))

    if (page === 'plain') await smokeHook(run, hitAfter, check)
  } finally {
    killTree(proc)
    await rm(actDir, { recursive: true, force: true })
    for (let i = 0; i < 20 && await isCdpUp(); i++) await sleep(250)
  }
}

async function main(): Promise<void> {
  if (await isCdpUp()) throw new Error(`CDP ${CDP_PORT} is taken: close the running cesium-app first`)
  await startServer()
  const token = (await readFile(TOKEN_PATH, 'utf8')).trim()
  const checks: boolean[] = []
  const check = (name: string, passed: boolean, detail = ''): void => {
    checks.push(passed)
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }
  try {
    for (const page of ['index', 'plain'] as const) {
      console.log(`[smoke-cesium] ${page} page`)
      await smokePage(page, token, check)
    }
  } finally {
    await sendCommand({ token, command: 'stop', args: {} }).catch(() => {})
  }
  const passed = checks.filter(Boolean).length
  console.log(`\n[smoke-cesium] ${passed}/${checks.length} checks passed`)
  process.exit(passed === checks.length ? 0 : 1)
}

main().catch((err: unknown) => {
  console.error('[smoke-cesium] FATAL:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
