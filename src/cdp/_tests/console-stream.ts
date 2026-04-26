import type { RuntimeSession, ConsoleMessage, ConsoleLevel, TargetType } from '../types.js'

const DEFAULT_CAPACITY = 500

export type ConsoleStreamOptions = {
  /** Per-target ring size. Default 500. */
  capacity?: number
}

export type ConsoleFilter = {
  since?: number
  level?: ReadonlySet<ConsoleLevel>
  targetId?: string
}

export type StampedConsoleMessage = ConsoleMessage & {
  targetId: string
  targetType: TargetType
}

type AttachedTarget = {
  session: RuntimeSession
  ring: StampedConsoleMessage[]
  cursor: number
  full: boolean
  dispose: () => void
}

/**
 * Multi-target console subscription with per-target ring buffer.
 * Server owns one instance for its lifetime; commands attach/drain.
 */
export class ConsoleStream {
  private readonly capacity: number
  private readonly targets = new Map<string, AttachedTarget>()
  private readonly extraSubscribers = new Set<(msg: StampedConsoleMessage) => void>()

  constructor(opts: ConsoleStreamOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY
  }

  get attachedCount(): number {
    return this.targets.size
  }

  /** Idempotent per target id — second attach for same id is a no-op. */
  attach(session: RuntimeSession): void {
    const id = session.target.id
    if (this.targets.has(id)) return

    const entry: AttachedTarget = {
      session,
      ring: new Array(this.capacity),
      cursor: 0,
      full: false,
      dispose: () => { /* set below */ },
    }

    entry.dispose = session.onConsole((msg) => {
      const stamped: StampedConsoleMessage = {
        ...msg,
        targetId: id,
        targetType: session.target.type,
      }
      entry.ring[entry.cursor] = stamped
      entry.cursor = (entry.cursor + 1) % this.capacity
      if (entry.cursor === 0) entry.full = true
      for (const sub of this.extraSubscribers) {
        try { sub(stamped) } catch { /* ignore */ }
      }
    })

    this.targets.set(id, entry)
  }

  detach(targetId?: string): void {
    if (targetId === undefined) {
      for (const t of this.targets.values()) t.dispose()
      this.targets.clear()
      return
    }
    const t = this.targets.get(targetId)
    if (!t) return
    t.dispose()
    this.targets.delete(targetId)
  }

  clear(targetId?: string): void {
    if (targetId === undefined) {
      for (const t of this.targets.values()) {
        t.cursor = 0
        t.full = false
      }
      return
    }
    const t = this.targets.get(targetId)
    if (!t) return
    t.cursor = 0
    t.full = false
  }

  /** Snapshot of buffered messages, sorted by timestamp (oldest first). */
  drain(filter: ConsoleFilter = {}): StampedConsoleMessage[] {
    const result: StampedConsoleMessage[] = []
    for (const [id, entry] of this.targets) {
      if (filter.targetId && filter.targetId !== id) continue
      const msgs = this.snapshot(entry)
      for (const m of msgs) {
        if (filter.since !== undefined && m.ts < filter.since) continue
        if (filter.level && !filter.level.has(m.level)) continue
        result.push(m)
      }
    }
    result.sort((a, b) => a.ts - b.ts)
    return result
  }

  /** Subscribe to live messages. Returns disposer. Used by --follow streaming. */
  subscribe(handler: (msg: StampedConsoleMessage) => void): () => void {
    this.extraSubscribers.add(handler)
    return () => this.extraSubscribers.delete(handler)
  }

  private snapshot(entry: AttachedTarget): StampedConsoleMessage[] {
    if (!entry.full) return entry.ring.slice(0, entry.cursor)
    return [...entry.ring.slice(entry.cursor), ...entry.ring.slice(0, entry.cursor)]
  }
}
