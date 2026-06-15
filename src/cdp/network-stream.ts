import type { RuntimeSession, TargetType } from './types.js'
import {
  NetworkEventKind,
  NetworkEntryState,
  NetworkResourceType,
  WebSocketOpcode,
  WebSocketDirection,
  type NetworkEntry,
  type NetworkEvent,
  type NetworkFilter,
  type WebSocketFrame,
  type NetworkBody,
} from './types.js'

const DEFAULT_CAPACITY = 200
const FRAME_RING = 100
const PAYLOAD_CAP = 2048
const BODY_CAP = 16 * 1024

export type StampedNetworkEntry = NetworkEntry & { targetId: string; targetType: TargetType }

type AttachedTarget = {
  session: RuntimeSession
  entries: Map<string, NetworkEntry>
  dispose: () => void
}

function globToRegex(pattern: string): RegExp {
  const segments = pattern.split('*')
  const escaped = segments.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(escaped.join('.*'), 'i')
}

function isBinaryMime(mime: string): boolean {
  return !mime.startsWith('text/') && !mime.includes('json') && !mime.includes('xml') && !mime.includes('javascript')
}

export class NetworkStream {
  private readonly capacity: number
  private readonly captureBody: boolean
  private readonly targets = new Map<string, AttachedTarget>()
  private readonly subscribers = new Set<(entry: StampedNetworkEntry) => void>()

  constructor(opts: { capacity?: number; captureBody?: boolean } = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY
    this.captureBody = opts.captureBody ?? false
  }

  get attachedCount(): number {
    return this.targets.size
  }

  async attach(session: RuntimeSession): Promise<void> {
    const id = session.target.id
    if (this.targets.has(id)) return

    const entries = new Map<string, NetworkEntry>()

    const dispose = session.onNetwork((ev) => this.handleEvent(id, entries, session, ev))

    this.targets.set(id, { session, entries, dispose })

    await session.enableNetwork()
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
      for (const t of this.targets.values()) t.entries.clear()
      return
    }
    this.targets.get(targetId)?.entries.clear()
  }

  subscribe(handler: (entry: StampedNetworkEntry) => void): () => void {
    this.subscribers.add(handler)
    return () => this.subscribers.delete(handler)
  }

  drain(filter: NetworkFilter = {}): StampedNetworkEntry[] {
    const urlRe = filter.url ? (filter.url.includes('*') ? globToRegex(filter.url) : null) : null
    const hasStatusFilter =
      (filter.statusClasses !== undefined && filter.statusClasses.size > 0) ||
      (filter.statusCodes !== undefined && filter.statusCodes.size > 0) ||
      filter.includeFailed === true

    const result: StampedNetworkEntry[] = []

    for (const [id, target] of this.targets) {
      if (filter.targetId && filter.targetId !== id) continue

      for (const entry of target.entries.values()) {
        if (filter.since !== undefined && entry.startTs < filter.since) continue

        if (filter.url) {
          const lowerUrl = entry.url.toLowerCase()
          if (urlRe) {
            if (!urlRe.test(entry.url)) continue
          } else {
            if (!lowerUrl.includes(filter.url.toLowerCase())) continue
          }
        }

        if (filter.method) {
          if (!entry.method) continue
          if (!filter.method.has(entry.method.toUpperCase())) continue
        }

        if (hasStatusFilter) {
          const matchesFailed = filter.includeFailed === true && entry.state === NetworkEntryState.Failed
          let matchesNumeric = false
          if (entry.status !== undefined) {
            const cls = Math.floor(entry.status / 100)
            const matchesClass = filter.statusClasses ? filter.statusClasses.has(cls) : false
            const matchesCode = filter.statusCodes ? filter.statusCodes.has(entry.status) : false
            matchesNumeric = matchesClass || matchesCode
          }
          if (!matchesFailed && !matchesNumeric) continue
        }

        if (filter.type && !filter.type.has(entry.resourceType)) continue

        result.push({ ...entry, targetId: id, targetType: target.session.target.type })
      }
    }

    result.sort((a, b) => a.startTs - b.startTs)
    return result
  }

  getEntry(targetId: string, requestId: string): StampedNetworkEntry | undefined {
    const target = this.targets.get(targetId)
    if (!target) return undefined
    const entry = target.entries.get(requestId)
    if (!entry) return undefined
    return { ...entry, targetId, targetType: target.session.target.type }
  }

  private notify(targetId: string, target: AttachedTarget, entry: NetworkEntry): void {
    const stamped: StampedNetworkEntry = { ...entry, targetId, targetType: target.session.target.type }
    for (const sub of this.subscribers) {
      try { sub(stamped) } catch { /* ignore */ }
    }
  }

  private upsertEntry(targetId: string, target: AttachedTarget, requestId: string, entry: NetworkEntry): void {
    const isNew = !target.entries.has(requestId)
    target.entries.set(requestId, entry)
    if (isNew && target.entries.size > this.capacity) {
      const firstKey = target.entries.keys().next().value
      if (firstKey !== undefined) target.entries.delete(firstKey)
    }
    this.notify(targetId, target, entry)
  }

  private handleEvent(
    targetId: string,
    entries: Map<string, NetworkEntry>,
    session: RuntimeSession,
    ev: NetworkEvent,
  ): void {
    const target = this.targets.get(targetId)
    if (!target) return

    switch (ev.kind) {
      case NetworkEventKind.RequestWillBeSent: {
        const entry: NetworkEntry = {
          requestId: ev.requestId,
          url: ev.url,
          method: ev.method,
          resourceType: ev.resourceType,
          state: NetworkEntryState.Pending,
          requestHeaders: ev.headers,
          startTs: ev.ts,
          requestBody: this.captureBody ? ev.postData : undefined,
        }
        this.upsertEntry(targetId, target, ev.requestId, entry)
        break
      }

      case NetworkEventKind.ResponseReceived: {
        const existing = entries.get(ev.requestId)
        const entry: NetworkEntry = existing ?? {
          requestId: ev.requestId,
          url: '',
          resourceType: ev.resourceType,
          state: NetworkEntryState.Pending,
          startTs: ev.ts,
        }
        entry.status = ev.status
        entry.statusText = ev.statusText
        entry.responseHeaders = ev.headers
        entry.mimeType = ev.mimeType
        entry.ttfbMs = existing ? ev.ts - existing.startTs : 0
        this.upsertEntry(targetId, target, ev.requestId, entry)
        break
      }

      case NetworkEventKind.LoadingFinished: {
        const existing = entries.get(ev.requestId)
        if (!existing) break
        existing.state = NetworkEntryState.Complete
        existing.endTs = ev.ts
        existing.totalMs = ev.ts - existing.startTs
        existing.encodedDataLength = ev.encodedDataLength
        this.notify(targetId, target, existing)

        if (this.captureBody) {
          session.getResponseBody(ev.requestId).then(({ body, base64Encoded }) => {
            const mime = existing.mimeType ?? ''
            const binary = base64Encoded || isBinaryMime(mime)
            let networkBody: NetworkBody
            if (binary) {
              const decoded = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body)
              networkBody = { text: '', base64: base64Encoded, size: decoded.byteLength, binary: true }
            } else {
              const size = Buffer.byteLength(body)
              networkBody = { text: body.slice(0, BODY_CAP), base64: false, size, binary: false }
            }
            existing.responseBody = networkBody
            this.notify(targetId, target, existing)
          }).catch(() => { /* swallow */ })
        }
        break
      }

      case NetworkEventKind.LoadingFailed: {
        const existing = entries.get(ev.requestId)
        if (!existing) break
        existing.state = NetworkEntryState.Failed
        existing.endTs = ev.ts
        existing.totalMs = ev.ts - existing.startTs
        existing.errorText = ev.errorText
        existing.canceled = ev.canceled
        this.notify(targetId, target, existing)
        break
      }

      case NetworkEventKind.WebSocketCreated: {
        const entry: NetworkEntry = {
          requestId: ev.requestId,
          url: ev.url,
          resourceType: NetworkResourceType.WebSocket,
          isWebSocket: true,
          state: NetworkEntryState.Pending,
          startTs: ev.ts,
          frames: [],
        }
        this.upsertEntry(targetId, target, ev.requestId, entry)
        break
      }

      case NetworkEventKind.WebSocketFrameSent:
      case NetworkEventKind.WebSocketFrameReceived: {
        let entry = entries.get(ev.requestId)
        if (!entry) {
          entry = {
            requestId: ev.requestId,
            url: '',
            resourceType: NetworkResourceType.WebSocket,
            isWebSocket: true,
            state: NetworkEntryState.Pending,
            startTs: ev.ts,
            frames: [],
          }
          this.upsertEntry(targetId, target, ev.requestId, entry)
        }
        if (!entry.frames) entry.frames = []

        const direction =
          ev.kind === NetworkEventKind.WebSocketFrameSent
            ? WebSocketDirection.Sent
            : WebSocketDirection.Received

        const isBinaryFrame = ev.opcode === WebSocketOpcode.Binary
        const frame: WebSocketFrame = {
          direction,
          opcode: ev.opcode,
          ts: ev.ts,
          size: Buffer.byteLength(ev.payloadData),
          ...(isBinaryFrame ? { binary: true } : { payload: ev.payloadData.slice(0, PAYLOAD_CAP) }),
        }

        entry.frames.push(frame)
        if (entry.frames.length > FRAME_RING) entry.frames.shift()

        this.notify(targetId, target, entry)
        break
      }

      case NetworkEventKind.WebSocketFrameError: {
        const entry = entries.get(ev.requestId)
        if (!entry) break
        if (!entry.frames) entry.frames = []
        const frame: WebSocketFrame = {
          direction: WebSocketDirection.Received,
          opcode: WebSocketOpcode.Continuation,
          ts: ev.ts,
          size: 0,
          terminal: 'error',
          errorMessage: ev.errorMessage,
        }
        entry.frames.push(frame)
        if (entry.frames.length > FRAME_RING) entry.frames.shift()
        this.notify(targetId, target, entry)
        break
      }

      case NetworkEventKind.WebSocketClosed: {
        const entry = entries.get(ev.requestId)
        if (!entry) break
        if (!entry.frames) entry.frames = []
        const frame: WebSocketFrame = {
          direction: WebSocketDirection.Received,
          opcode: WebSocketOpcode.Close,
          ts: ev.ts,
          size: 0,
          terminal: 'closed',
        }
        entry.frames.push(frame)
        if (entry.frames.length > FRAME_RING) entry.frames.shift()
        entry.state = NetworkEntryState.Complete
        entry.endTs = ev.ts
        this.notify(targetId, target, entry)
        break
      }

      case NetworkEventKind.EventSourceMessageReceived: {
        let entry = entries.get(ev.requestId)
        if (!entry) {
          entry = {
            requestId: ev.requestId,
            url: '',
            resourceType: NetworkResourceType.EventSource,
            isEventSource: true,
            state: NetworkEntryState.Pending,
            startTs: ev.ts,
            frames: [],
          }
          this.upsertEntry(targetId, target, ev.requestId, entry)
        }
        if (!entry.frames) entry.frames = []
        if (!entry.isEventSource) entry.isEventSource = true

        const rawPayload = (ev.eventName ? ev.eventName + ': ' : '') + ev.data
        const frame: WebSocketFrame = {
          direction: WebSocketDirection.Received,
          opcode: WebSocketOpcode.Text,
          ts: ev.ts,
          size: Buffer.byteLength(ev.data),
          payload: rawPayload.slice(0, PAYLOAD_CAP),
        }
        entry.frames.push(frame)
        if (entry.frames.length > FRAME_RING) entry.frames.shift()
        this.notify(targetId, target, entry)
        break
      }
    }
  }
}
