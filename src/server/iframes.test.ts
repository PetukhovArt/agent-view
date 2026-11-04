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

const MARK = `<script>function mark(id) { const p = document.createElement('p'); p.dataset.testid = id; p.textContent = id; document.body.appendChild(p) }</script>`

const pages = (httpPort: number): Record<string, string> => ({
  '/main.html': `<!doctype html><title>Host</title><body style="margin:0">
    <button data-testid="reload" onclick="location.reload()">Reload</button>
    <span data-testid="dup">Dup main</span>
    <iframe title="Child" src="/child.html" style="position:absolute;left:40px;top:60px;width:600px;height:420px;border:2px solid #000"></iframe>
    <iframe title="Offscreen" src="/offscreen.html" style="position:absolute;left:3000px;top:0;width:200px;height:100px;border:0"></iframe>
    <iframe title="Cross" src="http://127.0.0.1:${httpPort}/cross.html" style="position:absolute;left:700px;top:60px;width:200px;height:100px;border:0"></iframe>
    <div id="overlay" style="position:absolute;left:40px;top:440px;width:400px;height:60px;background:rgba(0,0,0,.3)"></div>
  </body>`,
  '/child.html': `<!doctype html><body style="margin:0">${MARK}
    <button data-testid="child-btn" onclick="mark('child-clicked')">Child Button</button>
    <input data-testid="child-input" aria-label="Child field" oninput="document.getElementById('echo').textContent = 'typed: ' + this.value">
    <p id="echo"></p>
    <input id="child-file" type="file" style="display:none" onchange="document.getElementById('file').textContent = 'file: ' + this.files[0].name">
    <p id="file"></p>
    <span data-testid="dup">Dup child</span>
    <button onclick="mark('ref-clicked')">Ref Target</button>
    <button onclick="mark('act-one-clicked')">Act Step One</button>
    <button style="position:absolute;left:10px;top:390px" onclick="mark('covered-clicked')">Covered Button</button>
    <iframe title="Grand" src="/grand.html" style="position:absolute;left:250px;top:150px;width:300px;height:200px;border:0"></iframe>
  </body>`,
  '/grand.html': `<!doctype html><body style="margin:0">${MARK}<div style="height:40px"></div>
    <button onclick="mark('grand-clicked')">Grand Button</button>
    <button data-testid="act-two" onclick="if (parent.document.querySelector('[data-testid=act-one-clicked]')) mark('act-done')">Act Step Two</button>
  </body>`,
  '/offscreen.html': `<!doctype html><body><button>Offscreen Button</button></body>`,
  '/cross.html': `<!doctype html><body><button data-testid="cross-btn">Cross Button</button></body>`,
})

const freePort = (): Promise<number> => new Promise((resolve) => {
  const probe = createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address() as { port: number }
    probe.close(() => resolve(port))
  })
})

async function until<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const value = await read().catch(() => undefined)
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 100))
  }
}

describe.skipIf(!chromePath)('elements inside iframes', () => {
  let http: Server
  let chrome: ChildProcess
  let cdpPort: number
  let profile: string
  const cwd = mkdtempSync(join(tmpdir(), 'av-iframes-'))
  const server = new AgentViewServer() as unknown as {
    handleCommand: (req: unknown) => Promise<ServerResponse>
    dropSessionsForPort: (port: number) => void
  }
  const run = (command: string, args: Record<string, unknown> = {}) =>
    server.handleCommand({ command, port: cdpPort, runtime: RuntimeType.Browser, args: { cwd, ...args } })
  const data = async (command: string, args: Record<string, unknown> = {}): Promise<string> => {
    const response = await run(command, args)
    if (!response.ok) throw new Error(`${command} failed: ${response.error}`)
    return String(response.data)
  }

  beforeAll(async () => {
    http = createServer((req, res) => {
      const body = pages((http.address() as { port: number }).port)[(req.url ?? '').split('?')[0]]
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' }).end(body ?? '')
    })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const httpPort = (http.address() as { port: number }).port
    cdpPort = await freePort()
    profile = mkdtempSync(join(tmpdir(), 'av-iframes-chrome-'))
    chrome = spawn(chromePath!, [
      '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run',
      '--no-default-browser-check', '--no-sandbox', '--window-size=1280,800', `http://localhost:${httpPort}/main.html`,
    ], { stdio: 'ignore' })
    await until(async () => {
      const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json() as Array<{ type: string }>
      return targets.some(t => t.type === 'iframe') || undefined
    }, 'the cross-origin frame target')
    await data('wait', { testid: 'act-two' })
  }, 30_000)

  afterAll(async () => {
    server.dropSessionsForPort(cdpPort)
    chrome?.kill()
    http?.close()
    await new Promise(r => setTimeout(r, 500))
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  })

  it('dom finds and lists elements of nested same-origin frames, with their test ids', async () => {
    expect(await data('dom', { filter: 'Grand Button' })).toMatch(/button "Grand Button" \[ref=\d+\]/)
    expect(await data('dom', { filter: 'Act Step Two' })).toContain('button "Act Step Two" [testid=act-two]')
  })

  it('clicks by test id, by text and by ref inside frames, at the frame-offset point', async () => {
    expect(await data('click', { testid: 'child-btn' })).toBe('Clicked testid "child-btn"')
    await data('wait', { testid: 'child-clicked', timeout: 3 })

    expect(await data('click', { filter: 'Grand Button' })).toBe('Clicked "Grand Button"')
    await data('wait', { testid: 'grand-clicked', timeout: 3 })

    const ref = /button "Ref Target" \[ref=(\d+)\]/.exec(await data('dom', { filter: 'Ref Target' }))?.[1]
    expect(await data('click', { ref: Number(ref) })).toBe(`Clicked ref ${ref}`)
    await data('wait', { testid: 'ref-clicked', timeout: 3 })
  })

  it('fills, types into the focused field and uploads inside a frame; wait reads the frame', async () => {
    await data('fill', { testid: 'child-input', value: 'hello' })
    await data('key', { keys: 'x', testid: 'child-input' })
    expect(await data('wait', { filter: 'typed: hellox', timeout: 3 })).toContain('typed: hellox')

    const file = join(cwd, 'a.txt')
    writeFileSync(file, 'a')
    await data('upload', { selector: '#child-file', files: [file] })
    await data('wait', { filter: 'file: a.txt', timeout: 3 })

    expect(await data('wait', { testid: 'dup', timeout: 1 })).toBe('Found testid "dup" (first visible of 2)')
  })

  it('records an act run across frames and replays it after a reload', async () => {
    const table = await data('act', { op: 'start', untilTestid: 'act-done', save: 'iframe-flow', in: 'fixture' })
    expect(table).not.toContain('Offscreen Button')
    const row = (name: string) => [...table.matchAll(/\[(\d+)\] button "([^"]+)"/g)].find(m => m[2] === name)?.[1]

    expect(await data('act', { op: 'click', target: row('Covered Button') })).toMatch(/covered by div#overlay/)
    expect(await data('act', { op: 'click', target: row('Act Step One') })).toMatch(/^✓ click \[\d+\] button "Act Step One"/)
    expect(await data('act', { op: 'click', target: 'testid=act-two' })).toMatch(/^DONE: .* saved /)

    await data('click', { testid: 'reload' })
    await data('wait', { testid: 'act-two' })
    expect(await run('act', { op: 'replay', name: 'iframe-flow' })).toMatchObject({ ok: true, exitCode: 0 })
    await data('wait', { testid: 'act-done', timeout: 1 })
  }, 60_000)

  it('names the cross-origin frame it cannot reach instead of a bare not-found', async () => {
    const outOfReach = /Not searched: cross-origin frame in another process, out of agent-view's reach: http:\/\/127\.0\.0\.1:\d+\/cross\.html/
    expect(await run('click', { testid: 'cross-btn' })).toMatchObject({ ok: false, error: expect.stringMatching(outOfReach) })
    expect(await run('click', { filter: 'Cross Button' })).toMatchObject({ ok: false, error: expect.stringMatching(outOfReach) })
    expect(await data('dom', { filter: 'Cross Button' })).toMatch(outOfReach)
  })
})
