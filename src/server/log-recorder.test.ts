import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  LogRecorder,
  filterLogLines,
  formatLogRecord,
  parseSinceToken,
  readFeedLines,
  resolveLogFile,
  type LogRecorderOptions,
} from './log-recorder.js'
import { ConsoleLevel, ConsoleSource, TargetType, type RuntimeSession } from '../cdp/types.js'
import type { StampedConsoleMessage } from '../cdp/_tests/console-stream.js'

function msg(overrides: Partial<StampedConsoleMessage> = {}): StampedConsoleMessage {
  return {
    ts: Date.parse('2026-07-25T09:31:02.500Z'),
    level: ConsoleLevel.Log,
    source: ConsoleSource.Runtime,
    text: 'hello',
    targetId: 'C2A5985A1234',
    targetType: TargetType.SharedWorker,
    ...overrides,
  }
}

type FakeSession = RuntimeSession & {
  /** Probe sources actually injected (marker checks excluded). */
  injected: string[]
  /** Wipes the JS context the way a page reload does, keeping the target id. */
  reload: () => void
  failEvaluate: boolean
}

function fakeSession(id: string, type = TargetType.SharedWorker): FakeSession {
  const injected: string[] = []
  let registry = new Set<string>()
  const session: FakeSession = {
    injected,
    failEvaluate: false,
    reload: () => { registry = new Set() },
    target: { id, type, title: 'w', url: 'file:///SharedWorker.ts' },
    evaluate: async (expression: string) => {
      if (session.failEvaluate) throw new Error('context destroyed')
      const check = /^!!\(globalThis\.__avProbes && globalThis\.__avProbes\["(.+)"\]\)$/.exec(expression)
      if (check) return registry.has(check[1])
      const marker = /globalThis\.__avProbes\["(.+)"\] = 1;$/.exec(expression)
      if (marker) registry.add(marker[1])
      injected.push(expression)
      return undefined
    },
    onDisconnect: () => {},
    onConsole: () => () => {},
    onNetwork: () => () => {},
    enableNetwork: async () => {},
    getResponseBody: async () => ({ body: '', base64Encoded: false }),
    close: async () => {},
  }
  return session
}

describe('formatLogRecord', () => {
  it('collapses a multi-line message into one physical line', () => {
    const line = formatLogRecord(msg({ text: 'line1\nline2\r\nline3' }))
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toContain('line1\\nline2\\nline3')
  })

  it('keeps the stack on the same record as the message', () => {
    const line = formatLogRecord(msg({ text: 'boom', stack: 'at f (a.js:1)\nat g (b.js:2)' }))
    expect(line.split('\n')).toHaveLength(1)
    expect(line).toContain('boom\\nat f (a.js:1)\\nat g (b.js:2)')
  })

  it('starts every record with a clock stamp, level and origin', () => {
    expect(formatLogRecord(msg({ level: ConsoleLevel.Error }))).toMatch(
      /^\d{2}:\d{2}:\d{2}\.\d{3} \[error\] \[shared_worker:C2A5985A\] hello$/,
    )
  })
})

describe('filterLogLines', () => {
  const lines = [
    '09:30:00.000 [log] [page:AAAA1111] boot',
    '09:31:00.000 [warn] [page:AAAA1111] slow paint',
    '09:32:00.000 [error] [shared_worker:BBBB2222] ws closed',
    '09:33:00.000 [log] [shared_worker:BBBB2222] reconnect',
  ]

  it('drops records older than --since', () => {
    expect(filterLogLines(lines, { since: '09:32:00.000' })).toEqual([lines[2], lines[3]])
  })

  it('filters by level and by substring together', () => {
    expect(filterLogLines(lines, { level: new Set([ConsoleLevel.Log]), grep: 'reconnect' })).toEqual([lines[3]])
  })

  it('accepts /regex/ patterns', () => {
    expect(filterLogLines(lines, { grep: '/ws (closed|open)/' })).toEqual([lines[2]])
  })

  it('keeps the newest records when the limit cuts in', () => {
    expect(filterLogLines(lines, { limit: 2 })).toEqual([lines[2], lines[3]])
  })
})

describe('parseSinceToken', () => {
  const now = new Date('2026-07-25T09:35:00.000Z')

  it('resolves relative offsets against now', () => {
    const fiveMinutesAgo = parseSinceToken('-5m', now)
    expect(fiveMinutesAgo).toBe(parseSinceToken(new Date(now.getTime() - 5 * 60_000).toISOString(), now))
  })

  it('normalizes partial clock times', () => {
    expect(parseSinceToken('9:31')).toBe('09:31:00.000')
    expect(parseSinceToken('09:31:02.5')).toBe('09:31:02.500')
  })

  it('returns null for unparseable tokens', () => {
    expect(parseSinceToken('yesterday')).toBeNull()
    expect(parseSinceToken('99:99')).toBeNull()
  })
})

describe('LogRecorder', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'av-logs-'))
    file = join(dir, 'nested', 'console.log')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function build(opts: Partial<LogRecorderOptions> & { sessions?: () => RuntimeSession[] } = {}) {
    let emit: (m: StampedConsoleMessage) => void = () => {}
    const sessions = opts.sessions ?? (() => [])
    const recorder = new LogRecorder({
      file,
      rescanMs: 500,
      rescan: async () => sessions(),
      subscribe: (handler) => { emit = handler; return () => { emit = () => {} } },
      ...opts,
    })
    return { recorder, send: (m: StampedConsoleMessage) => emit(m) }
  }

  it('writes console messages to the feed and stops recording on stop', async () => {
    const { recorder, send } = build()
    await recorder.start()
    send(msg({ text: 'first' }))
    recorder.stop('test')
    send(msg({ text: 'after stop' }))

    const feed = readFileSync(file, 'utf8')
    expect(feed).toContain('first')
    expect(feed).not.toContain('after stop')
  })

  it('honours the level filter at write time', async () => {
    const { recorder, send } = build({ levels: new Set([ConsoleLevel.Error]) })
    await recorder.start()
    send(msg({ level: ConsoleLevel.Log, text: 'noise' }))
    send(msg({ level: ConsoleLevel.Error, text: 'boom' }))
    recorder.stop('test')

    const feed = readFileSync(file, 'utf8')
    expect(feed).toContain('boom')
    expect(feed).not.toContain('noise')
  })

  it('rotates to <file>.prev instead of growing without bound', async () => {
    const { recorder, send } = build({ maxBytes: 2048 })
    await recorder.start()
    for (let i = 0; i < 40; i++) send(msg({ text: `payload-${i}-${'x'.repeat(100)}` }))
    const status = recorder.status()
    recorder.stop('test')

    expect(status.rotations).toBeGreaterThan(0)
    expect(existsSync(`${file}.prev`)).toBe(true)
    expect(statSync(file).size).toBeLessThanOrEqual(2048 + 512)
  })

  it('truncates the feed on clear but keeps recording', async () => {
    const { recorder, send } = build()
    await recorder.start()
    send(msg({ text: 'before clear' }))
    recorder.clearFeed()
    send(msg({ text: 'after clear' }))
    recorder.stop('test')

    const feed = readFileSync(file, 'utf8')
    expect(feed).not.toContain('before clear')
    expect(feed).toContain('after clear')
  })

  it('re-injects a probe when a worker restarts under a new target id', async () => {
    const first = fakeSession('OLD11111')
    const second = fakeSession('NEW22222')
    let live = [first]
    const { recorder } = build({
      sessions: () => live,
      probes: [{ name: 'probe.js', source: 'globalThis.__p = 1' }],
    })

    await recorder.start()
    expect(first.injected).toHaveLength(1)

    live = [second]
    await new Promise(r => setTimeout(r, 700))
    recorder.stop('test')

    expect(second.injected).toHaveLength(1)
    expect(recorder.status().probes[0].injections).toBe(2)
  })

  it('re-injects after a page reload, which keeps the target id but wipes the context', async () => {
    const page = fakeSession('PAGE1111', TargetType.Page)
    const { recorder } = build({
      sessions: () => [page],
      probes: [{ name: 'probe.js', source: 'globalThis.__p = 1' }],
    })

    await recorder.start()
    expect(page.injected).toHaveLength(1)

    // Idle rescans must not re-inject while the marker is still there.
    await new Promise(r => setTimeout(r, 700))
    expect(page.injected).toHaveLength(1)

    page.reload()
    await new Promise(r => setTimeout(r, 700))
    recorder.stop('test')

    expect(page.injected).toHaveLength(2)
    expect(recorder.status().probes[0].injections).toBe(2)
  })

  it('gives up on a target after repeated probe failures', async () => {
    const page = fakeSession('PAGE1111', TargetType.Page)
    page.failEvaluate = true
    const { recorder } = build({
      sessions: () => [page],
      probes: [{ name: 'probe.js', source: 'globalThis.__p = 1' }],
    })

    await recorder.start()
    await new Promise(r => setTimeout(r, 1700))
    recorder.stop('test')

    const feed = readFileSync(file, 'utf8')
    expect(feed).toContain('giving up on this target')
    expect(feed.match(/probe probe\.js failed/g)).toHaveLength(3)
  })

  it('keeps ticking when a rescan hangs instead of freezing the feed', async () => {
    let hang = true
    const { recorder, send } = build({
      rescanMs: 500,
      tickTimeoutMs: 300,
      sessions: undefined,
      rescan: () => hang ? new Promise<RuntimeSession[]>(() => {}) : Promise.resolve([]),
    })

    await recorder.start()
    hang = false
    await new Promise(r => setTimeout(r, 1200))
    const status = recorder.status()
    send(msg({ text: 'still recording' }))
    recorder.stop('test')

    const feed = readFileSync(file, 'utf8')
    expect(feed).toContain('rescan timed out')
    expect(feed).toContain('still recording')
    expect(status.ticks).toBeGreaterThan(1)
  })

  it('skips probes whose target query does not match', async () => {
    const page = fakeSession('PAGE1111', TargetType.Page)
    const { recorder } = build({
      sessions: () => [page],
      probes: [{ name: 'worker-only.js', source: 'globalThis.__p = 1', targetQuery: 'shared_worker' }],
    })
    await recorder.start()
    recorder.stop('test')
    expect(page.injected).toHaveLength(0)
  })
})

describe('feed file helpers', () => {
  it('resolves a relative logFile against the project root', () => {
    expect(resolveLogFile(join('C:', 'proj'), 'logs/app.log')).toBe(join('C:', 'proj', 'logs', 'app.log'))
    expect(resolveLogFile(join('C:', 'proj'))).toContain(join('.agent-view', 'console.log'))
  })

  it('drops the partial first record when the scan window starts mid-file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'av-scan-'))
    const file = join(dir, 'feed.log')
    const { recorder, send } = (() => {
      let emit: (m: StampedConsoleMessage) => void = () => {}
      const rec = new LogRecorder({ file, rescan: async () => [], subscribe: (h) => { emit = h; return () => {} } })
      return { recorder: rec, send: (m: StampedConsoleMessage) => emit(m) }
    })()

    return (async () => {
      await recorder.start()
      for (let i = 0; i < 5; i++) send(msg({ text: `record-${i}` }))
      recorder.stop('test')

      const size = statSync(file).size
      const { lines, scanTruncated } = readFeedLines(file, size - 20)
      expect(scanTruncated).toBe(true)
      expect(lines.every(l => /^\d{2}:\d{2}:\d{2}\.\d{3} /.test(l))).toBe(true)
      rmSync(dir, { recursive: true, force: true })
    })()
  })
})
