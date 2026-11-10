import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentViewServer } from './server.js'
import { RuntimeType, type ServerResponse } from '../types.js'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]
const chromePath = CHROME_CANDIDATES.find((p): p is string => p !== undefined && existsSync(p))

const PAGE = `<!doctype html><title>Host</title><body>
  <button data-testid="reload" onclick="location.reload()">Reload</button>
  <script>fetch('/api/page'); window.gateway = new SharedWorker('/gateway.js', 'gateway'); gateway.port.start()</script>
</body>`
const GATEWAY = `const boot = Math.random().toString(36).slice(2, 8); let n = 0
self.onconnect = (e) => e.ports[0].start()
setInterval(() => fetch('/api/ping?boot=' + boot + '&n=' + (n++), { method: 'POST', body: JSON.stringify({ boot, n }) }), 200)`

const freePort = (): Promise<number> => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number }
    probe.close(() => resolve(port))
  })
})

async function until<T>(read: () => Promise<T | undefined>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read().catch(() => undefined)
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

const boots = (list: string): Set<string> => new Set([...list.matchAll(/boot=(\w+)/g)].map(m => m[1]))

describe.skipIf(!chromePath)('network capture of a shared worker', () => {
  let http: Server
  let chrome: ChildProcess
  let cdpPort: number
  let httpPort: number
  let profile: string
  const cwd = mkdtempSync(join(tmpdir(), 'av-sw-network-'))
  const server = new AgentViewServer() as unknown as {
    handleCommand: (req: unknown) => Promise<ServerResponse>
    dropSessionsForPort: (port: number) => void
  }
  const data = async (command: string, args: Record<string, unknown> = {}): Promise<string> => {
    const response = await server.handleCommand({ command, port: cdpPort, runtime: RuntimeType.Browser, args: { cwd, maxLines: 1000, ...args } })
    if (!response.ok) throw new Error(`${command} failed: ${response.error}`)
    return String(response.data)
  }
  const cdp = (path: string, method = 'GET') => fetch(`http://127.0.0.1:${cdpPort}${path}`, { method })
  const targets = async () => await (await cdp('/json/list')).json() as Array<{ id: string; type: string; title: string }>
  const workerIds = async () => (await targets()).filter(t => t.type === 'shared_worker').map(t => t.id)

  beforeAll(async () => {
    http = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]
      if (path === '/page.html') return void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE)
      if (path === '/gateway.js') return void res.writeHead(200, { 'content-type': 'application/javascript' }).end(GATEWAY)
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ pong: body })))
    })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    httpPort = (http.address() as { port: number }).port
    cdpPort = await freePort()
    writeFileSync(join(cwd, 'agent-view.config.json'), JSON.stringify({ runtime: 'browser', port: cdpPort, launch: 'none', captureBody: true }))
    profile = mkdtempSync(join(tmpdir(), 'av-sw-network-chrome-'))
    chrome = spawn(chromePath!, [
      '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run',
      '--no-default-browser-check', '--no-sandbox', `http://127.0.0.1:${httpPort}/page.html`,
    ], { stdio: 'ignore' })
    await until(async () => (await workerIds()).length === 1 || undefined, 'the shared worker target')
  }, 30_000)

  afterAll(async () => {
    server.dropSessionsForPort(cdpPort)
    chrome?.kill()
    http?.close()
    await new Promise(r => setTimeout(r, 500))
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  })

  it('lists the worker fetches, by --target, by --follow, and with both bodies in --req', async () => {
    await data('network')
    await until(async () => {
      const text = await data('network')
      return /POST 200 fetch \S+\/api\/ping\?boot=\w+&n=\d+ \d+ms \[shared_worker:\w{8}\]/.test(text) ? text : undefined
    }, 'a worker fetch in the list')

    const onlyWorker = await data('network', { target: 'gateway' })
    const ref = /\[req=(\d+)\] POST 200 fetch \S+\/api\/ping/.exec(onlyWorker)?.[1]
    const detail = await data('network', { req: Number(ref) })
    expect(detail).toMatch(/request body:\n\{"boot":"\w+","n":\d+\}/)
    expect(detail).toMatch(/response body:\n\{"pong":"\{\\"boot\\"/)

    await data('network', { target: 'gateway', clear: true })
    expect(await data('network', { target: 'gateway', follow: true, until: '/api/ping', timeout: 5 })).toContain('/api/ping?boot=')
  }, 30_000)

  it('keeps capturing a worker the page reload re-creates, and the re-created worker runs', async () => {
    const [workerId] = await workerIds()
    const before = boots(await data('network', { target: 'gateway' }))
    await data('click', { testid: 'reload' })
    const after = await until(async () => {
      const seen = boots(await data('network', { target: 'gateway' }))
      return [...seen].some(b => !before.has(b)) ? seen : undefined
    }, 'fetches of the re-created worker')
    expect(after.size).toBeGreaterThan(before.size)
    expect(await workerIds()).toEqual([workerId])

    expect(await data('network')).toMatch(/GET 200 fetch \S+\/api\/page \d+ms$/m)
    expect(await data('network', { target: 'gateway' })).not.toContain('/api/page')
  }, 30_000)

  it('lets go of a worker gone from the target list, keeps its entries, and attaches the next one on its own', async () => {
    const lastPing = (list: string) => [...list.matchAll(/\[req=(\d+)\] POST 200 fetch \S+\/api\/ping/g)].at(-1)?.[1]
    const [page] = (await targets()).filter(t => t.type === 'page')
    const [goneId] = await workerIds()
    await until(async () => lastPing(await data('network', { target: 'gateway' })), 'a completed worker fetch')
    const gone = boots(await data('network', { target: 'gateway' }))
    await cdp(`/json/close/${page.id}`)
    await until(async () => (await workerIds()).length === 0 || undefined, 'the worker to end')
    const justEnded = await data('network', { target: 'gateway' })
    expect(await data('network', { req: Number(lastPing(justEnded)) })).toContain('response body: unavailable: the worker is gone')
    await new Promise(r => setTimeout(r, 4_000))

    const whileGone = await data('network', { target: 'gateway' })
    expect([...gone].every(b => whileGone.includes(`boot=${b}`))).toBe(true)
    expect(await data('network', { req: Number(lastPing(whileGone)) })).toContain('response body: unavailable: the worker is gone')

    await cdp(`/json/new?http://127.0.0.1:${httpPort}/page.html`, 'PUT')
    const [nextId] = await until(async () => { const ids = await workerIds(); return ids.length === 1 ? ids : undefined }, 'the next worker')
    expect(nextId).not.toBe(goneId)
    await new Promise(r => setTimeout(r, 4_000))
    const next = await data('network', { target: 'gateway' })
    const fresh = [...boots(next)].filter(b => !gone.has(b))
    expect(fresh).toHaveLength(1)
    expect(next.match(new RegExp(`boot=${fresh[0]}&`, 'g'))?.length ?? 0).toBeGreaterThan(5)
    expect([...gone].every(b => next.includes(`boot=${b}`))).toBe(true)
  }, 40_000)
})
