import { describe, it, expect, vi } from 'vitest'
import { NetworkStream } from '../network-stream.js'
import {
  TargetType,
  NetworkEventKind,
  NetworkEntryState,
  NetworkResourceType,
  WebSocketOpcode,
  WebSocketDirection,
  type NetworkEvent,
  type RuntimeSession,
} from '../types.js'

type FakeSession = RuntimeSession & { emit: (ev: NetworkEvent) => void }

function makeSession(id: string, type: TargetType = TargetType.Page): FakeSession {
  let networkHandler: ((ev: NetworkEvent) => void) | null = null
  let enableNetworkCalled = false

  const session: FakeSession = {
    target: { id, type, title: '', url: '' },
    evaluate: vi.fn().mockResolvedValue(undefined),
    onConsole: (_handler) => () => {},
    onNetwork: (handler) => {
      networkHandler = handler
      return () => { networkHandler = null }
    },
    enableNetwork: vi.fn().mockImplementation(async () => {
      enableNetworkCalled = true
      // guard: handler must be registered before enableNetwork resolves
      expect(networkHandler).not.toBeNull()
    }),
    getResponseBody: vi.fn().mockResolvedValue({ body: 'response-text', base64Encoded: false }),
    close: vi.fn().mockResolvedValue(undefined),
    emit(ev) { networkHandler?.(ev) },
  }

  // expose for tests
  Object.defineProperty(session, '_enableNetworkCalled', { get: () => enableNetworkCalled })

  return session
}

const baseReqSent = (requestId: string, ts = 100, url = 'https://example.com/api'): NetworkEvent => ({
  kind: NetworkEventKind.RequestWillBeSent,
  requestId,
  ts,
  url,
  method: 'GET',
  resourceType: NetworkResourceType.Fetch,
  headers: { 'x-req': '1' },
})

const baseRespReceived = (requestId: string, ts = 200): NetworkEvent => ({
  kind: NetworkEventKind.ResponseReceived,
  requestId,
  ts,
  status: 200,
  statusText: 'OK',
  headers: { 'content-type': 'application/json' },
  mimeType: 'application/json',
  resourceType: NetworkResourceType.Fetch,
})

const baseLoadingFinished = (requestId: string, ts = 300): NetworkEvent => ({
  kind: NetworkEventKind.LoadingFinished,
  requestId,
  ts,
  encodedDataLength: 42,
})

describe('NetworkStream', () => {
  it('attach is idempotent per target id', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)
    await stream.attach(s)
    expect(stream.attachedCount).toBe(1)
    expect(vi.mocked(s.enableNetwork)).toHaveBeenCalledTimes(1)
  })

  it('attach awaits enableNetwork and onNetwork is registered first', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)
    // enableNetwork mock asserts handler is non-null when it runs
    expect(vi.mocked(s.enableNetwork)).toHaveBeenCalledTimes(1)
  })

  it('full HTTP lifecycle produces Complete entry with status/totalMs/ttfbMs', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit(baseReqSent('r1', 100))
    s.emit(baseRespReceived('r1', 250))
    s.emit(baseLoadingFinished('r1', 400))

    const [entry] = stream.drain()
    expect(entry.state).toBe(NetworkEntryState.Complete)
    expect(entry.status).toBe(200)
    expect(entry.ttfbMs).toBe(150)
    expect(entry.totalMs).toBe(300)
    expect(entry.targetId).toBe('a')
  })

  it('in-flight entry stays Pending; loadingFinished updates same entry', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit(baseReqSent('r1', 100))
    const pending = stream.drain()
    expect(pending).toHaveLength(1)
    expect(pending[0].state).toBe(NetworkEntryState.Pending)
    expect(pending[0].requestId).toBe('r1')

    s.emit(baseLoadingFinished('r1', 200))
    const done = stream.drain()
    expect(done).toHaveLength(1)
    expect(done[0].requestId).toBe('r1')
    expect(done[0].state).toBe(NetworkEntryState.Complete)
  })

  it('loadingFailed sets state=Failed and errorText', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit(baseReqSent('r1', 100))
    s.emit({
      kind: NetworkEventKind.LoadingFailed,
      requestId: 'r1',
      ts: 200,
      errorText: 'net::ERR_CONNECTION_REFUSED',
      canceled: false,
      resourceType: NetworkResourceType.Fetch,
    })

    const [entry] = stream.drain()
    expect(entry.state).toBe(NetworkEntryState.Failed)
    expect(entry.errorText).toBe('net::ERR_CONNECTION_REFUSED')
  })

  it('filter by url substring', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit(baseReqSent('r1', 100, 'https://example.com/api/users'))
    s.emit(baseReqSent('r2', 101, 'https://example.com/static/logo.png'))

    const out = stream.drain({ url: '/api/' })
    expect(out).toHaveLength(1)
    expect(out[0].requestId).toBe('r1')
  })

  it('filter by url glob', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit(baseReqSent('r1', 100, 'https://example.com/api/users'))
    s.emit(baseReqSent('r2', 101, 'https://other.io/api/data'))
    s.emit(baseReqSent('r3', 102, 'https://example.com/static/logo.png'))

    const out = stream.drain({ url: '*/api/*' })
    expect(out.map(e => e.requestId).sort()).toEqual(['r1', 'r2'])
  })

  it('filter by method drops entries without method and non-matching', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit({ ...baseReqSent('r1'), method: 'POST' } as NetworkEvent)
    s.emit({ ...baseReqSent('r2'), method: 'GET' } as NetworkEvent)

    const out = stream.drain({ method: new Set(['POST']) })
    expect(out).toHaveLength(1)
    expect(out[0].requestId).toBe('r1')
  })

  it('filter by status class (4xx) keeps only 4xx entries and drops Pending', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit(baseReqSent('r1', 100))
    s.emit({ kind: NetworkEventKind.ResponseReceived, requestId: 'r1', ts: 200, status: 404, statusText: 'Not Found', headers: {}, mimeType: 'text/html', resourceType: NetworkResourceType.Fetch })
    s.emit(baseLoadingFinished('r1', 300))

    s.emit(baseReqSent('r2', 101))
    s.emit(baseRespReceived('r2', 201))
    s.emit(baseLoadingFinished('r2', 301))

    s.emit(baseReqSent('r3', 102)) // Pending — no response yet

    const out = stream.drain({ statusClasses: new Set([4]) })
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe(404)
  })

  it('filter by exact status code (404)', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit(baseReqSent('r1', 100))
    s.emit({ kind: NetworkEventKind.ResponseReceived, requestId: 'r1', ts: 200, status: 404, statusText: 'Not Found', headers: {}, mimeType: 'text/html', resourceType: NetworkResourceType.Fetch })
    s.emit(baseLoadingFinished('r1', 300))

    s.emit(baseReqSent('r2', 101))
    s.emit({ kind: NetworkEventKind.ResponseReceived, requestId: 'r2', ts: 200, status: 403, statusText: 'Forbidden', headers: {}, mimeType: 'text/html', resourceType: NetworkResourceType.Fetch })
    s.emit(baseLoadingFinished('r2', 300))

    const out = stream.drain({ statusCodes: new Set([404]) })
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe(404)
  })

  it('filter by includeFailed keeps Failed entries (no HTTP status) and drops completed', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit(baseReqSent('r1', 100))
    s.emit({ kind: NetworkEventKind.LoadingFailed, requestId: 'r1', ts: 200, errorText: 'net::ERR_FAILED', canceled: false, resourceType: NetworkResourceType.Fetch })

    s.emit(baseReqSent('r2', 101))
    s.emit(baseRespReceived('r2', 201))
    s.emit(baseLoadingFinished('r2', 301))

    const out = stream.drain({ includeFailed: true })
    expect(out).toHaveLength(1)
    expect(out[0].requestId).toBe('r1')
    expect(out[0].state).toBe(NetworkEntryState.Failed)
  })

  it('includeFailed combines with status class — failed OR matching code pass', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit(baseReqSent('r1', 100))
    s.emit({ kind: NetworkEventKind.LoadingFailed, requestId: 'r1', ts: 200, errorText: 'net::ERR_FAILED', canceled: false, resourceType: NetworkResourceType.Fetch })

    s.emit(baseReqSent('r2', 101))
    s.emit({ kind: NetworkEventKind.ResponseReceived, requestId: 'r2', ts: 201, status: 500, statusText: 'Error', headers: {}, mimeType: 'text/html', resourceType: NetworkResourceType.Fetch })
    s.emit(baseLoadingFinished('r2', 301))

    s.emit(baseReqSent('r3', 102))
    s.emit(baseRespReceived('r3', 202))
    s.emit(baseLoadingFinished('r3', 302))

    const out = stream.drain({ includeFailed: true, statusClasses: new Set([5]) })
    expect(out.map(e => e.requestId).sort()).toEqual(['r1', 'r2'])
  })

  it('filter by type', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit({ kind: NetworkEventKind.RequestWillBeSent, requestId: 'r1', ts: 100, url: 'https://a.com/img.png', method: 'GET', resourceType: NetworkResourceType.Image, headers: {} })
    s.emit(baseReqSent('r2', 101))

    const out = stream.drain({ type: new Set([NetworkResourceType.Image]) })
    expect(out).toHaveLength(1)
    expect(out[0].requestId).toBe('r1')
  })

  it('drain is sorted oldest→newest by startTs across two targets', async () => {
    const stream = new NetworkStream()
    const a = makeSession('a')
    const b = makeSession('b')
    await stream.attach(a)
    await stream.attach(b)

    b.emit(baseReqSent('b1', 50))
    a.emit(baseReqSent('a1', 100))
    b.emit(baseReqSent('b2', 200))

    const out = stream.drain()
    expect(out.map(e => e.requestId)).toEqual(['b1', 'a1', 'b2'])
  })

  it('ring eviction at capacity keeps newest entries', async () => {
    const stream = new NetworkStream({ capacity: 3 })
    const s = makeSession('a')
    await stream.attach(s)

    for (let i = 1; i <= 5; i++) {
      s.emit(baseReqSent(`r${i}`, i * 10))
    }

    const out = stream.drain()
    expect(out).toHaveLength(3)
    expect(out.map(e => e.requestId)).toEqual(['r3', 'r4', 'r5'])
  })

  it('WS lifecycle: frames accumulate with correct direction; closed appends terminal frame and sets Complete', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit({ kind: NetworkEventKind.WebSocketCreated, requestId: 'ws1', ts: 100, url: 'wss://example.com/ws' })
    s.emit({ kind: NetworkEventKind.WebSocketFrameSent, requestId: 'ws1', ts: 110, opcode: WebSocketOpcode.Text, payloadData: 'hello' })
    s.emit({ kind: NetworkEventKind.WebSocketFrameReceived, requestId: 'ws1', ts: 120, opcode: WebSocketOpcode.Text, payloadData: 'world' })
    s.emit({ kind: NetworkEventKind.WebSocketClosed, requestId: 'ws1', ts: 200 })

    const [entry] = stream.drain()
    expect(entry.isWebSocket).toBe(true)
    expect(entry.frames).toHaveLength(3) // sent, received, terminal
    expect(entry.frames![0].direction).toBe(WebSocketDirection.Sent)
    expect(entry.frames![1].direction).toBe(WebSocketDirection.Received)
    expect(entry.frames![2].terminal).toBe('closed')
    expect(entry.state).toBe(NetworkEntryState.Complete)
  })

  it('EventSource message lands a frame and sets isEventSource', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit({ kind: NetworkEventKind.EventSourceMessageReceived, requestId: 'es1', ts: 100, eventName: 'tick', data: 'payload-1', messageId: 'm1' })
    s.emit({ kind: NetworkEventKind.EventSourceMessageReceived, requestId: 'es1', ts: 110, eventName: '', data: 'payload-2', messageId: 'm2' })

    const [entry] = stream.drain()
    expect(entry.isEventSource).toBe(true)
    expect(entry.resourceType).toBe(NetworkResourceType.EventSource)
    expect(entry.frames).toHaveLength(2)
    expect(entry.frames![0].direction).toBe(WebSocketDirection.Received)
    expect(entry.frames![0].payload).toBe('tick: payload-1')
    expect(entry.frames![1].payload).toBe('payload-2')
  })

  it('body captured only when captureBody:true; getResponseBody called', async () => {
    const stream = new NetworkStream({ captureBody: true })
    const s = makeSession('a')
    await stream.attach(s)
    s.emit(baseReqSent('r1', 100))
    s.emit(baseRespReceived('r1', 200))
    s.emit(baseLoadingFinished('r1', 300))
    await Promise.resolve()
    expect(vi.mocked(s.getResponseBody)).toHaveBeenCalledWith('r1')
    const [e] = stream.drain()
    expect(e.responseBody).toBeDefined()
    expect(e.responseBody!.text).toBe('response-text')
  })

  it('body NOT captured when captureBody:false', async () => {
    const stream = new NetworkStream({ captureBody: false })
    const s = makeSession('a')
    await stream.attach(s)
    s.emit(baseReqSent('r1', 100))
    s.emit(baseRespReceived('r1', 200))
    s.emit(baseLoadingFinished('r1', 300))
    await Promise.resolve()
    expect(vi.mocked(s.getResponseBody)).not.toHaveBeenCalled()
    const [e] = stream.drain()
    expect(e.responseBody).toBeUndefined()
  })

  it('clear empties entries but keeps subscription live', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    s.emit(baseReqSent('r1', 100))
    expect(stream.drain()).toHaveLength(1)

    stream.clear('a')
    expect(stream.drain()).toHaveLength(0)

    s.emit(baseReqSent('r2', 200))
    expect(stream.drain()).toHaveLength(1)
  })

  it('subscribe receives live entries until disposer called', async () => {
    const stream = new NetworkStream()
    const s = makeSession('a')
    await stream.attach(s)

    const seen: string[] = []
    const dispose = stream.subscribe(e => seen.push(e.requestId))

    s.emit(baseReqSent('r1', 100))
    dispose()
    s.emit(baseReqSent('r2', 200))

    expect(seen).toEqual(['r1'])
  })
})
