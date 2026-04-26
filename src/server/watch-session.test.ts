import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WatchSession } from './watch-session.js'
import { StopReason, type WatchFrame } from '../inspectors/watch/index.js'
import type { RuntimeSession, TargetInfo } from '../cdp/types.js'
import { TargetType } from '../cdp/types.js'

const target: TargetInfo = { id: 't1', type: TargetType.Page, title: 'test', url: 'about:blank' }

function makeSession(evaluate: (expr: string) => unknown): RuntimeSession {
  return {
    target,
    evaluate: vi.fn(async (expr: string) => evaluate(expr)),
    onConsole: () => () => {},
    close: async () => {},
  }
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('WatchSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('happy path: 3 values → init + 2 diff + stop(max-changes)', async () => {
    const values = [{ n: 1 }, { n: 2 }, { n: 3 }]
    let i = 0
    const session = makeSession(() => values[Math.min(i++, values.length - 1)])

    const frames: WatchFrame[] = []
    const watch = new WatchSession(session, {
      expression: 'state',
      intervalMs: 100,
      durationS: 60,
      maxChanges: 2,
      emit: (f) => { frames.push(f); return true },
    })
    await watch.start()
    await tick(250)

    expect(frames.map(f => f.type)).toEqual(['init', 'diff', 'diff', 'stop'])
    const stop = frames.at(-1) as Extract<WatchFrame, { type: 'stop' }>
    expect(stop.reason).toBe(StopReason.MaxChanges)
    expect(stop.ok).toBe(true)
    expect(stop.count).toBe(2)
  })

  it('--until truthy on second tick → init + 1 diff + stop(until)', async () => {
    const values = [{ status: 'loading' }, { status: 'ready' }]
    let mainCallIdx = -1
    let lastValue: { status: string } = values[0]
    const session = makeSession((expr) => {
      // Main capture wrapper contains "JSON.parse(JSON.stringify". Until expr does not.
      const isMain = expr.includes('JSON.parse')
      if (isMain) {
        mainCallIdx = Math.min(mainCallIdx + 1, values.length - 1)
        lastValue = values[mainCallIdx]
        return lastValue
      }
      // until: evaluates lastValue.status === 'ready'
      return lastValue.status === 'ready'
    })

    const frames: WatchFrame[] = []
    const watch = new WatchSession(session, {
      expression: 'state',
      intervalMs: 50,
      durationS: 60,
      maxChanges: 100,
      until: 'state.status === "ready"',
      emit: (f) => { frames.push(f); return true },
    })
    await watch.start()
    await tick(200)

    const types = frames.map(f => f.type)
    expect(types[0]).toBe('init')
    expect(types).toContain('diff')
    const stop = frames.at(-1) as Extract<WatchFrame, { type: 'stop' }>
    expect(stop.type).toBe('stop')
    expect(stop.reason).toBe(StopReason.Until)
    expect(stop.ok).toBe(true)
  })

  it('duration elapsed without changes → init + stop(duration), 0 diff', async () => {
    const session = makeSession(() => ({ same: true }))

    const frames: WatchFrame[] = []
    const watch = new WatchSession(session, {
      expression: 'state',
      intervalMs: 50,
      durationS: 0.2, // 200ms
      maxChanges: 100,
      emit: (f) => { frames.push(f); return true },
    })
    await watch.start()
    await tick(500)

    const types = frames.map(f => f.type)
    expect(types[0]).toBe('init')
    expect(types).not.toContain('diff')
    const stop = frames.at(-1) as Extract<WatchFrame, { type: 'stop' }>
    expect(stop.reason).toBe(StopReason.Duration)
    expect(stop.ok).toBe(true)
  })

  it('5 consecutive throws → stop(eval-failed, ok:false)', async () => {
    const session = makeSession(() => { throw new Error('boom') })

    const frames: WatchFrame[] = []
    const watch = new WatchSession(session, {
      expression: 'state',
      intervalMs: 20,
      durationS: 60,
      maxChanges: 100,
      emit: (f) => { frames.push(f); return true },
    })
    await watch.start()
    await tick(500)

    const stop = frames.at(-1) as Extract<WatchFrame, { type: 'stop' }>
    expect(stop.type).toBe('stop')
    expect(stop.reason).toBe(StopReason.EvalFailed)
    expect(stop.ok).toBe(false)
  })

  it('throws 3 times then succeeds → counter resets, watch continues', async () => {
    const sequence: Array<() => unknown> = [
      () => { throw new Error('e1') },
      () => { throw new Error('e2') },
      () => { throw new Error('e3') },
      () => ({ a: 1 }),
      () => ({ a: 2 }),
      () => ({ a: 3 }),
    ]
    let i = 0
    const session = makeSession(() => sequence[Math.min(i++, sequence.length - 1)]())

    const frames: WatchFrame[] = []
    const watch = new WatchSession(session, {
      expression: 'state',
      intervalMs: 20,
      durationS: 60,
      maxChanges: 2,
      emit: (f) => { frames.push(f); return true },
    })
    await watch.start()
    await tick(500)

    const stop = frames.at(-1) as Extract<WatchFrame, { type: 'stop' }>
    expect(stop.reason).toBe(StopReason.MaxChanges)
    expect(stop.ok).toBe(true)
  })

  it('size cap → error frame, watch continues', async () => {
    const small = { a: 1 }
    const big = { data: 'x'.repeat(300_000) }
    const seq = [small, big, small, small]
    let i = 0
    const session = makeSession(() => seq[Math.min(i++, seq.length - 1)])

    const frames: WatchFrame[] = []
    const watch = new WatchSession(session, {
      expression: 'state',
      intervalMs: 20,
      durationS: 60,
      maxChanges: 1,
      emit: (f) => { frames.push(f); return true },
    })
    await watch.start()
    await tick(500)

    expect(frames.some(f => f.type === 'error')).toBe(true)
  })

  it('SIGINT (external stop) → stop(sigint, ok:true)', async () => {
    const session = makeSession(() => ({ a: 1 }))

    const frames: WatchFrame[] = []
    const watch = new WatchSession(session, {
      expression: 'state',
      intervalMs: 50,
      durationS: 60,
      maxChanges: 100,
      emit: (f) => { frames.push(f); return true },
    })
    await watch.start()
    await tick(20)
    watch.stop(StopReason.Sigint, true)
    await tick(200)

    const stop = frames.at(-1) as Extract<WatchFrame, { type: 'stop' }>
    expect(stop.reason).toBe(StopReason.Sigint)
    expect(stop.ok).toBe(true)
  })

  it('non-cloneable wrapper error on init → init has __watchError, watch continues', async () => {
    let i = 0
    const session = makeSession(() => {
      if (i++ === 0) return { __watchError: 'value not serializable: function' }
      return { a: 1 }
    })

    const frames: WatchFrame[] = []
    const watch = new WatchSession(session, {
      expression: 'state',
      intervalMs: 20,
      durationS: 60,
      maxChanges: 1,
      emit: (f) => { frames.push(f); return true },
    })
    await watch.start()
    await tick(500)

    expect(frames[0].type).toBe('init')
    const initFrame = frames[0] as Extract<WatchFrame, { type: 'init' }>
    expect(initFrame.value).toEqual({ __watchError: 'value not serializable: function' })
    const stop = frames.at(-1) as Extract<WatchFrame, { type: 'stop' }>
    expect(stop.reason).toBe(StopReason.MaxChanges)
  })

  it('idempotent stop', async () => {
    const session = makeSession(() => ({ a: 1 }))
    const frames: WatchFrame[] = []
    const watch = new WatchSession(session, {
      expression: 'state',
      intervalMs: 50,
      durationS: 60,
      maxChanges: 100,
      emit: (f) => { frames.push(f); return true },
    })
    await watch.start()
    watch.stop(StopReason.Sigint, true)
    watch.stop(StopReason.Sigint, true)
    await tick(100)
    const stops = frames.filter(f => f.type === 'stop')
    expect(stops.length).toBe(1)
  })
})
