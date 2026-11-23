import { createConnection } from 'node:net'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import CDP from 'chrome-remote-interface'
import { AgentViewServer } from '../src/server/server.js'
import { SERVER_PORT, TOKEN_PATH } from '../src/server/port.js'
import { RuntimeType, WebGLEngine } from '../src/types.js'
import type { AuditResult } from '../src/inspectors/audit/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CDP_PORT = 19224

type Resp = { ok: boolean; data?: unknown; error?: string; exitCode?: number }

const EXPECTED = [
  'offscreen error bad-offscreen',
  'offscreen error bad-dialog-text',
  'clipped error bad-clipped',
  'clipped error bad-clipped-icon',
  'clipped error bad-clipped-in-scroller',
  'text-clip error bad-textclip',
  'text-clip error bad-textclip-v',
  'overlap error bad-overlap-a',
  'target-size warn bad-small-button',
  'contrast warn bad-contrast',
  'contrast warn bad-contrast-opacity',
].sort()

function sendCommand(req: Record<string, unknown>, timeoutMs = 20_000): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: SERVER_PORT })
    let buf = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`Command timed out after ${timeoutMs}ms`)) }, timeoutMs)
    socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'))
    socket.on('data', (chunk) => {
      buf += chunk.toString()
      if (buf.includes('\n')) {
        clearTimeout(timer)
        socket.destroy()
        try { resolve(JSON.parse(buf.trim()) as Resp) } catch { reject(new Error(`Invalid JSON response: ${buf}`)) }
      }
    })
    socket.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

const isCdpUp = (): Promise<boolean> => fetch(`http://127.0.0.1:${CDP_PORT}/json/version`).then(r => r.ok, () => false)

function spawnElectron(): ChildProcess {
  const appDir = join(__dirname, 'app')
  const exeName = readFileSync(join(appDir, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()
  const bin = join(appDir, 'node_modules', 'electron', 'dist', exeName)
  return spawn(bin, ['main.js', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'av-smoke-audit-app-'))}`], { cwd: appDir, stdio: 'ignore', env: { ...process.env, BENCH_INACTIVE: '1' } })
}

async function startServer(): Promise<void> {
  await sendCommand({ command: 'stop', port: 0, runtime: RuntimeType.Electron, args: {}, token: '' }, 3_000).catch(() => {})
  for (let i = 0; i < 20; i++) {
    try { await new AgentViewServer().start(); return } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
      await new Promise(r => setTimeout(r, 200))
    }
  }
  throw new Error(`port ${SERVER_PORT} stayed occupied`)
}

async function open(url: string): Promise<void> {
  const page = (await CDP.List({ port: CDP_PORT })).find(t => t.type === 'page')!
  const client = await CDP({ port: CDP_PORT, target: page.id })
  await client.Page.enable()
  const loaded = new Promise<void>(r => client.Page.loadEventFired(() => r()))
  await client.Page.navigate({ url })
  await loaded
  await client.close()
}

const label = (f: AuditResult['findings'][number]): string => `${f.rule} ${f.severity} ${f.target.testid ?? f.target.selector}`

async function main(): Promise<void> {
  const proc = (await isCdpUp()) ? undefined : spawnElectron()
  for (let i = 0; i < 40 && !(await isCdpUp()); i++) await new Promise(r => setTimeout(r, 500))
  await startServer()
  const token = readFileSync(TOKEN_PATH, 'utf8').trim()
  const base = { token, runtime: RuntimeType.Electron, port: CDP_PORT }
  const cwd = mkdtempSync(join(tmpdir(), 'av-smoke-audit-'))
  const run = (command: string, args: Record<string, unknown> = {}) => sendCommand({ ...base, command, args: { ...args, cwd } })

  const checks: Array<{ passed: boolean }> = []
  const check = (name: string, passed: boolean, detail = ''): void => {
    checks.push({ passed })
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  }

  try {
    await open(pathToFileURL(join(__dirname, 'app', 'audit.html')).href)
    const emulated = await run('emulate', { width: 800, height: 600, scale: 1 })
    check('emulate 800x600 returns ok', emulated.ok, emulated.error ?? '')

    console.log('\n[smoke] audit finds exactly the planted defects')
    const full = await run('audit')
    const result = full.data as AuditResult
    const got = result.findings.map(label).sort()
    check('findings match the planted set', JSON.stringify(got) === JSON.stringify(EXPECTED), got.join(' | '))
    check('no near-miss control is flagged', !result.findings.some(f => (f.target.testid ?? '').startsWith('ok-')))
    check('counts are 8 errors and 3 warnings', result.counts.error === 8 && result.counts.warn === 3, JSON.stringify(result.counts))
    check('viewport is the emulated one', result.viewport.width === 800 && result.viewport.height === 600, JSON.stringify(result.viewport))
    check('an error finding gives exit code 1', full.exitCode === 1, String(full.exitCode))

    console.log('\n[smoke] rules, root, exit codes')
    const warnOnly = await run('audit', { rules: ['contrast', 'target-size'] })
    check('warnings alone give exit code 0', warnOnly.ok && !warnOnly.exitCode, String(warnOnly.exitCode))
    const rooted = await run('audit', { root: '[data-testid="bad-dialog"]' })
    const rootedLabels = ((rooted.data as AuditResult | undefined)?.findings ?? []).map(label)
    check('--root keeps only that subtree', rootedLabels.join() === 'offscreen error bad-dialog-text', rootedLabels.join(' | ') || rooted.error)
    const unknown = await run('audit', { rules: ['nope'] })
    check('an unknown rule is refused', !unknown.ok && String(unknown.error).includes('Unknown audit rule'), unknown.error ?? '')
    const missing = await run('audit', { root: '#no-such-element' })
    check('a missing root is refused', !missing.ok && String(missing.error).includes('No element found'), missing.error ?? '')

    console.log('\n[smoke] coarse pointer raises the target size to 44px as errors')
    await run('emulate', { pointer: 'coarse' })
    const coarse = (await run('audit', { rules: ['target-size'] })).data as AuditResult
    check('coarse pointer is reported', coarse.coarsePointer)
    check('target-size findings turn into errors', coarse.findings.length > 1 && coarse.findings.every(f => f.severity === 'error'), `${coarse.findings.length} findings`)
    await run('emulate', { reset: true })

    console.log('\n[smoke] --shot draws the findings')
    const shotPath = join(cwd, 'audit.png')
    const shot = await run('audit', { shot: shotPath })
    const written = existsSync(shotPath) ? readFileSync(shotPath) : Buffer.alloc(0)
    check('--shot writes a PNG', shot.ok && written.subarray(1, 4).toString() === 'PNG', shotPath)

    console.log('\n[smoke] audit --scene through the app scene hook')
    const runScene = (args: Record<string, unknown> = {}) => sendCommand({ ...base, engine: WebGLEngine.AppHook, command: 'audit', args: { ...args, scene: true, cwd } })
    const noHook = await runScene()
    check('a page with no hook exits with a clear message', !noHook.ok && String(noHook.error).startsWith('No scene: window.__AGENT_VIEW_SCENE__'), noHook.error ?? '')
    const noEngine = await sendCommand({ ...base, command: 'audit', args: { scene: true, cwd } })
    check('another engine is told it gives no bounds', !noEngine.ok && String(noEngine.error).includes('gives no bounds'), noEngine.error ?? '')

    await open(`${pathToFileURL(join(__dirname, 'app', 'scene-hook.html')).href}?nobounds`)
    const noBounds = await runScene()
    check('a hook without bounds says to expose them', !noBounds.ok && String(noBounds.error).includes('gives no bounds'), noBounds.error ?? '')

    await open(pathToFileURL(join(__dirname, 'app', 'scene-hook.html')).href)
    await run('emulate', { width: 800, height: 600, scale: 1 })
    const scene = await runScene()
    const sceneResult = scene.data as AuditResult
    const sceneGot = (sceneResult?.findings ?? []).map(label).sort()
    const sceneExpected = ['scene-offscreen error bad-edge', 'scene-overlap error bad-overlap-a', 'scene-text-out error bad-text-out']
    check('scene findings match the planted set', JSON.stringify(sceneGot) === JSON.stringify(sceneExpected), sceneGot.join(' | ') || scene.error)
    check('a scene error gives exit code 1', scene.exitCode === 1, String(scene.exitCode))
    const only = await runScene({ rules: ['scene-overlap'] })
    check('--rules narrows to one scene rule', ((only.data as AuditResult | undefined)?.findings ?? []).map(label).join() === 'scene-overlap error bad-overlap-a')
    const wrongRule = await runScene({ rules: ['overlap'] })
    check('a page rule is refused with --scene', !wrongRule.ok && String(wrongRule.error).includes('Unknown audit rule'), wrongRule.error ?? '')
    const sceneShot = join(cwd, 'scene.png')
    await runScene({ shot: sceneShot })
    check('--shot works for a scene', existsSync(sceneShot))
  } finally {
    await run('emulate', { reset: true }).catch(() => {})
    await sendCommand({ token, command: 'stop', args: {} }).catch(() => {})
    proc?.kill()
  }

  const passed = checks.filter(c => c.passed).length
  console.log(`\n[smoke] ${passed}/${checks.length} checks passed`)
  if (passed !== checks.length) process.exit(1)
}

main().catch((err: unknown) => { console.error(err); process.exit(1) })
