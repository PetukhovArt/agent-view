import type { RuntimeSession, TargetInfo } from './types.js'
import {
  TargetType,
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
const MAX_GONE_TARGETS = 8

export type StampedNetworkEntry = NetworkEntry & { targetId: string; targetType: TargetType }

type CapturedTarget = {
  target: TargetInfo
  liveSession: RuntimeSession | null
  entries: Map<string, NetworkEntry>
  dispose: () => void
}

const isSameSharedWorker = (a: TargetInfo, b: TargetInfo): boolean =>
  a.type === TargetType.SharedWorker && b.type === TargetType.SharedWorker && a.url === b.url && a.title === b.title

function globToRegex(pattern: string): RegExp {
  const segments = pattern.split('*')
  const escaped = segments.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(escaped.join('.*'), 'i')
}

function isBinaryMime(mime: string): boolean {
  return !mime.startsWith('text/') && !mime.includes('json') && !mime.includes('xml') && !mime.includes('javascript')
}

function toNetworkBody(body: string, base64Encoded: boolean, mime: string): NetworkBody {
  if (base64Encoded || isBinaryMime(mime)) {
    const decoded = base64Encoded ? Buffer.from(body, 'base64') : Buffer.from(body)
    return { text: '', base64: base64Encoded, size: decoded.byteLength, binary: true }
  }
  return { text: body.slice(0, BODY_CAP), base64: false, size: Buffer.byteLength(body), binary: false }
}

const isBodyFetchedOnDemand = (target: TargetInfo): boolean => target.type === TargetType.SharedWorker

const hasResponseBody = (entry: NetworkEntry): boolean =>
  entry.state === NetworkEntryState.Complete && !entry.isWebSocket && !entry.isEventSource

export class NetworkStream {
  private readonly capacity: number
  private readonly captureBody: boolean
  private readonly targets = new Map<string, CapturedTarget>()
  private readonly subscribers = new Set<(entry: StampedNetworkEntry) => void>()

  constructor(opts: { capacity?: number; captureBody?: boolean } = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY
    this.captureBody = opts.captureBody ?? false
  }

  get attachedCount(): number {
    return this.attachedTargetIds().length
  }

  get isEmpty(): boolean {
    return this.targets.size === 0
  }

  attachedTargetIds(): string[] {
    return [...this.targets.values()].filter(t => t.liveSession !== null).map(t => t.target.id)
  }

  capturedTargets(): TargetInfo[] {
    const captured: TargetInfo[] = []
    for (const t of this.targets.values()) {
      const sameWorker = captured.findIndex(c => isSameSharedWorker(c, t.target))
      if (sameWorker === -1) captured.push(t.target)
      else captured[sameWorker] = t.target
    }
    return captured
  }

  async attach(session: RuntimeSession): Promise<void> {
    const id = session.target.id
    const known = this.targets.get(id)
    if (known?.liveSession) return

    const captured: CapturedTarget = { target: session.target, liveSession: session, entries: known?.entries ?? new Map(), dispose: () => {} }
    captured.dispose = session.onNetwork((ev) => this.handleEvent(captured, ev))
    this.targets.set(id, captured)

    try {
      await session.enableNetwork()
    } catch (err) {
      this.detach(id)
      throw err
    }
  }

  detach(targetId?: string): void {
    if (targetId === undefined) {
      for (const t of this.targets.values()) t.dispose()
      this.targets.clear()
      return
    }
    const t = this.targets.get(targetId)
    if (!t?.liveSession) return
    t.dispose()
    t.liveSession = null
    if (t.entries.size === 0) this.targets.delete(targetId)
    this.evictOldestGone()
  }

  clear(targetId?: string): void {
    for (const [id, t] of this.targets) {
      if (targetId !== undefined && !this.isOfTarget(t, targetId)) continue
      t.entries.clear()
      if (t.liveSession === null) this.targets.delete(id)
    }
  }

  private evictOldestGone(): void {
    const gone = [...this.targets.values()].filter(t => t.liveSession === null)
    for (const t of gone.slice(0, Math.max(0, gone.length - MAX_GONE_TARGETS))) this.targets.delete(t.target.id)
  }

  private isOfTarget(t: CapturedTarget, targetId: string): boolean {
    if (t.target.id === targetId) return true
    const wanted = this.targets.get(targetId)?.target
    return wanted !== undefined && isSameSharedWorker(wanted, t.target)
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
      if (filter.targetId && !this.isOfTarget(target, filter.targetId)) continue

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

        result.push({ ...entry, targetId: id, targetType: target.target.type })
      }
    }

    result.sort((a, b) => a.startTs - b.startTs)
    return result
  }

  async getEntry(targetId: string, requestId: string, isTargetListed: () => Promise<boolean>): Promise<StampedNetworkEntry | undefined> {
    const target = this.targets.get(targetId)
    if (!target) return undefined
    const entry = target.entries.get(requestId)
    if (!entry) return undefined
    if (this.captureBody && isBodyFetchedOnDemand(target.target) && hasResponseBody(entry) && entry.responseBody === undefined) {
      await this.fetchBodyOnDemand(target, entry, isTargetListed)
    }
    return { ...entry, targetId, targetType: target.target.type }
  }

  private async fetchBodyOnDemand(target: CapturedTarget, entry: NetworkEntry, isTargetListed: () => Promise<boolean>): Promise<void> {
    if (!target.liveSession || !await isTargetListed()) {
      entry.responseBodyUnavailable = 'the worker is gone'
      return
    }
    try {
      const { body, base64Encoded } = await target.liveSession.getResponseBody(entry.requestId)
      entry.responseBody = toNetworkBody(body, base64Encoded, entry.mimeType ?? '')
      entry.responseBodyUnavailable = undefined
    } catch (err) {
      entry.responseBodyUnavailable = err instanceof Error ? err.message : String(err)
    }
  }

  private notify(target: CapturedTarget, entry: NetworkEntry): void {
    const stamped: StampedNetworkEntry = { ...entry, targetId: target.target.id, targetType: target.target.type }
    for (const sub of this.subscribers) {
      try { sub(stamped) } catch { /* ignore */ }
    }
  }

  private upsertEntry(target: CapturedTarget, requestId: string, entry: NetworkEntry): void {
    const isNew = !target.entries.has(requestId)
    target.entries.set(requestId, entry)
    if (isNew && target.entries.size > this.capacity) {
      const firstKey = target.entries.keys().next().value
      if (firstKey !== undefined) target.entries.delete(firstKey)
    }
    this.notify(target, entry)
  }

  private handleEvent(target: CapturedTarget, ev: NetworkEvent): void {
    const session = target.liveSession
    if (!session) return
    const { entries } = target

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
        this.upsertEntry(target, ev.requestId, entry)
        break
      }

      case NetworkEventKind.ResponseReceived: {
        const existing = entries.get(ev.requestId)
        const entry: NetworkEntry = existing ?? {
          requestId: ev.requestId,
          url: ev.url ?? '',
          resourceType: ev.resourceType,
          state: NetworkEntryState.Pending,
          startTs: ev.ts,
        }
        entry.status = ev.status
        entry.statusText = ev.statusText
        entry.responseHeaders = ev.headers
        entry.mimeType = ev.mimeType
        entry.ttfbMs = existing ? ev.ts - existing.startTs : 0
        this.upsertEntry(target, ev.requestId, entry)
        break
      }

      case NetworkEventKind.LoadingFinished: {
        const existing = entries.get(ev.requestId)
        if (!existing) break
        existing.state = NetworkEntryState.Complete
        existing.endTs = ev.ts
        existing.totalMs = ev.ts - existing.startTs
        existing.encodedDataLength = ev.encodedDataLength
        this.notify(target, existing)

        if (this.captureBody && !isBodyFetchedOnDemand(target.target)) {
          session.getResponseBody(ev.requestId).then(({ body, base64Encoded }) => {
            existing.responseBody = toNetworkBody(body, base64Encoded, existing.mimeType ?? '')
            this.notify(target, existing)
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
        this.notify(target, existing)
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
        this.upsertEntry(target, ev.requestId, entry)
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
          this.upsertEntry(target, ev.requestId, entry)
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

        this.notify(target, entry)
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
        this.notify(target, entry)
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
        this.notify(target, entry)
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
          this.upsertEntry(target, ev.requestId, entry)
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
        this.notify(target, entry)
        break
      }
    }
  }
}
