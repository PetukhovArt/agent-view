import { describe, it, expect, vi } from 'vitest'
import { ConsoleStream } from './console-stream.js'
import { ConsoleLevel, ConsoleSource, TargetType, type ConsoleMessage, type RuntimeSession } from '../types.js'

function makeSession(id: string, type: TargetType = TargetType.Page): RuntimeSession & { emit: (msg: ConsoleMessage) => void } {
  let emitter: ((msg: ConsoleMessage) => void) | null = null
  const session: RuntimeSession & { emit: (msg: ConsoleMessage) => void } = {
    target: { id, type, title: '', url: '' },
    evaluate: vi.fn().mockResolvedValue(undefined),
    onConsole: (handler) => {
      emitter = handler
      return () => { emitter = null }
    },
    close: vi.fn().mockResolvedValue(undefined),
    emit(msg) { emitter?.(msg) },
  }
  return session
}

function msg(text: string, ts: number, level: ConsoleLevel = ConsoleLevel.Log): ConsoleMessage {
  return { ts, level, source: ConsoleSource.Runtime, text }
}

describe('ConsoleStream', () => {
  it('attach is idempotent per target id', () => {
    const stream = new ConsoleStream({ capacity: 10 })
    const s = makeSession('a')
    stream.attach(s)
    stream.attach(s)
    expect(stream.attachedCount).toBe(1)
  })

  it('drain returns buffered messages sorted by timestamp', () => {
    const stream = new ConsoleStream({ capacity: 10 })
    const a = makeSession('a')
    const b = makeSession('b')
    stream.attach(a)
    stream.attach(b)

    a.emit(msg('a1', 100))
    b.emit(msg('b1', 50))
    a.emit(msg('a2', 200))

    const out = stream.drain()
    expect(out.map(m => m.text)).toEqual(['b1', 'a1', 'a2'])
  })

  it('filter by level only returns matching messages', () => {
    const stream = new ConsoleStream({ capacity: 10 })
    const a = makeSession('a')
    stream.attach(a)
    a.emit(msg('info', 1, ConsoleLevel.Info))
    a.emit(msg('err', 2, ConsoleLevel.Error))

    const out = stream.drain({ level: new Set([ConsoleLevel.Error]) })
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('err')
  })

  it('filter by since drops older messages', () => {
    const stream = new ConsoleStream({ capacity: 10 })
    const a = makeSession('a')
    stream.attach(a)
    a.emit(msg('old', 100))
    a.emit(msg('new', 200))

    const out = stream.drain({ since: 150 })
    expect(out.map(m => m.text)).toEqual(['new'])
  })

  it('filter by targetId restricts to one target', () => {
    const stream = new ConsoleStream({ capacity: 10 })
    const a = makeSession('a')
    const b = makeSession('b')
    stream.attach(a)
    stream.attach(b)

    a.emit(msg('a1', 1))
    b.emit(msg('b1', 2))

    const out = stream.drain({ targetId: 'b' })
    expect(out).toHaveLength(1)
    expect(out[0].targetId).toBe('b')
  })

  it('detach disposes underlying subscription', () => {
    const stream = new ConsoleStream({ capacity: 10 })
    const a = makeSession('a')
    stream.attach(a)
    stream.detach('a')
    expect(stream.attachedCount).toBe(0)

    // Re-attach should work after detach
    stream.attach(a)
    expect(stream.attachedCount).toBe(1)
  })

  it('clear empties ring but keeps subscription live', () => {
    const stream = new ConsoleStream({ capacity: 10 })
    const a = makeSession('a')
    stream.attach(a)
    a.emit(msg('first', 1))
    stream.clear()
    expect(stream.drain()).toHaveLength(0)
    a.emit(msg('after-clear', 2))
    expect(stream.drain()).toHaveLength(1)
  })

  it('respects capacity bound (oldest messages dropped)', () => {
    const stream = new ConsoleStream({ capacity: 3 })
    const a = makeSession('a')
    stream.attach(a)
    for (let i = 1; i <= 5; i++) a.emit(msg(`m${i}`, i))

    const out = stream.drain()
    expect(out).toHaveLength(3)
    expect(out.map(m => m.text)).toEqual(['m3', 'm4', 'm5'])
  })

  it('subscribe receives live messages until disposer called', () => {
    const stream = new ConsoleStream({ capacity: 10 })
    const a = makeSession('a')
    stream.attach(a)

    const seen: string[] = []
    const dispose = stream.subscribe((m) => seen.push(m.text))
    a.emit(msg('x', 1))
    dispose()
    a.emit(msg('y', 2))

    expect(seen).toEqual(['x'])
  })
})
