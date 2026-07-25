// @ts-expect-error no types available for chrome-remote-interface
import CDP from 'chrome-remote-interface'
import {
  TargetType,
  ConsoleLevel,
  ConsoleSource,
  EvaluationError,
  MouseButton,
  NetworkEventKind,
  NetworkResourceType,
  NetworkEntryState,
  WebSocketOpcode,
  WebSocketDirection,
  type CDPTarget,
  type AXNode,
  type ScreenshotClip,
  type ScreenshotOpts,
  type TargetInfo,
  type RuntimeSession,
  type PageSession,
  type ConsoleMessage,
  type EvaluateOpts,
  type DragOpts,
  type ClickOpts,
  type Point,
  type NetworkEvent,
} from './types.js'
import type { AxTreeCache } from './ax-cache.js'

// CDP hosts to try: IPv4 first, then IPv6 (WebView2/Tauri often listens on ::1)
const CDP_HOSTS = ['127.0.0.1', '::1'] as const

// Maps targetId → host for connection routing
const targetHostMap = new Map<string, string>()

const KNOWN_TARGET_TYPES: ReadonlySet<string> = new Set(Object.values(TargetType))

/**
 * Every /json/list probe and every WebSocket handshake is bounded. A port that
 * accepts TCP but never answers HTTP (app mid-restart, wedged renderer) would
 * otherwise leave the request pending forever — and since every command starts
 * by enumerating targets, one wedged app froze the whole server.
 */
const probeTimeoutMs = (): number => envMs('AGENT_VIEW_CDP_PROBE_TIMEOUT_MS', 5_000)
const connectTimeoutMs = (): number => envMs('AGENT_VIEW_CDP_CONNECT_TIMEOUT_MS', 10_000)

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

function hostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

export class CDPTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CDPTimeoutError'
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CDPTimeoutError(`${what} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fetchTargetList(host: string, port: number): Promise<CDPTarget[]> {
  const res = await fetch(`http://${hostForUrl(host)}:${port}/json/list`, {
    signal: AbortSignal.timeout(probeTimeoutMs()),
  })
  if (!res.ok) throw new Error(`CDP /json/list on ${host}:${port} returned ${res.status}`)
  const parsed: unknown = await res.json()
  return Array.isArray(parsed) ? parsed as CDPTarget[] : []
}

function toTargetInfo(t: CDPTarget): TargetInfo | null {
  if (!KNOWN_TARGET_TYPES.has(t.type)) return null
  return {
    id: t.id,
    type: t.type as TargetType,
    title: t.title ?? '',
    url: t.url ?? '',
  }
}

export async function listTargets(port: number): Promise<CDPTarget[]> {
  const seen = new Set<string>()
  const result: CDPTarget[] = []

  for (const host of CDP_HOSTS) {
    try {
      const targets = await fetchTargetList(host, port)
      for (const t of targets) {
        if (!seen.has(t.id)) {
          seen.add(t.id)
          targetHostMap.set(`${port}:${t.id}`, host)
          result.push(t)
        }
      }
    } catch { /* host not available */ }
  }

  return result
}

export async function listSupportedTargets(port: number): Promise<TargetInfo[]> {
  const raw = await listTargets(port)
  const result: TargetInfo[] = []
  for (const t of raw) {
    const info = toTargetInfo(t)
    if (info) result.push(info)
  }
  return result
}

type ConsoleSubscription = {
  emit: (msg: ConsoleMessage) => void
  add: (handler: (msg: ConsoleMessage) => void) => () => void
}

type RawCDPNetwork = {
  enable: (params?: Record<string, unknown>) => Promise<unknown>
  getResponseBody: (params: { requestId: string }) => Promise<{ body: string; base64Encoded: boolean }>
  requestWillBeSent: (cb: (p: Record<string, unknown>) => void) => () => void
  responseReceived: (cb: (p: Record<string, unknown>) => void) => () => void
  loadingFinished: (cb: (p: Record<string, unknown>) => void) => () => void
  loadingFailed: (cb: (p: Record<string, unknown>) => void) => () => void
  webSocketCreated: (cb: (p: Record<string, unknown>) => void) => () => void
  webSocketFrameSent: (cb: (p: Record<string, unknown>) => void) => () => void
  webSocketFrameReceived: (cb: (p: Record<string, unknown>) => void) => () => void
  webSocketFrameError: (cb: (p: Record<string, unknown>) => void) => () => void
  webSocketClosed: (cb: (p: Record<string, unknown>) => void) => () => void
  eventSourceMessageReceived: (cb: (p: Record<string, unknown>) => void) => () => void
}

type NetworkSubscription = {
  add: (handler: (ev: NetworkEvent) => void) => () => void
  enable: () => Promise<void>
  getResponseBody: (requestId: string) => Promise<{ body: string; base64Encoded: boolean }>
}

type RawCDPClient = {
  Runtime: {
    enable: () => Promise<unknown>
    evaluate: (params: Record<string, unknown>) => Promise<{
      result: { value?: unknown; type?: string; description?: string; subtype?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string }; stackTrace?: { description?: string } }
    }>
    callFunctionOn: (params: Record<string, unknown>) => Promise<unknown>
    consoleAPICalled: (cb: (params: ConsoleAPICalledEvent) => void) => () => void
  }
  Log: {
    enable: () => Promise<unknown>
    entryAdded: (cb: (params: LogEntryAddedEvent) => void) => () => void
  }
  Network: RawCDPNetwork
  on: (event: string, cb: () => void) => void
  close: () => Promise<unknown>
} & Record<string, unknown>

type RemoteObject = {
  type?: string
  subtype?: string
  value?: unknown
  description?: string
  unserializableValue?: string
}

type ConsoleAPICalledEvent = {
  type: string
  args: RemoteObject[]
  stackTrace?: { callFrames?: Array<{ functionName?: string; url?: string; lineNumber?: number; columnNumber?: number }> }
}

type LogEntryAddedEvent = {
  entry: {
    level: string
    text: string
    source?: string
    stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> }
  }
}

const CONSOLE_TYPE_TO_LEVEL: Record<string, ConsoleLevel> = {
  log: ConsoleLevel.Log,
  info: ConsoleLevel.Info,
  warn: ConsoleLevel.Warn,
  warning: ConsoleLevel.Warn,
  error: ConsoleLevel.Error,
  debug: ConsoleLevel.Debug,
  trace: ConsoleLevel.Debug,
}

function levelFromConsoleType(type: string): ConsoleLevel {
  return CONSOLE_TYPE_TO_LEVEL[type] ?? ConsoleLevel.Log
}

function levelFromLogEntry(level: string): ConsoleLevel {
  if (level === 'verbose') return ConsoleLevel.Debug
  if (level === 'warning') return ConsoleLevel.Warn
  if (level === 'info' || level === 'log' || level === 'error' || level === 'debug') {
    return level as ConsoleLevel
  }
  return ConsoleLevel.Log
}

function formatRemoteObject(obj: RemoteObject): string {
  if (obj.unserializableValue !== undefined) return String(obj.unserializableValue)
  if (obj.value !== undefined) {
    if (typeof obj.value === 'string') return obj.value
    try { return JSON.stringify(obj.value) } catch { return String(obj.value) }
  }
  if (obj.description) return obj.description
  if (obj.type) return `[${obj.type}${obj.subtype ? ` ${obj.subtype}` : ''}]`
  return ''
}

function formatStackTrace(stack?: ConsoleAPICalledEvent['stackTrace']): string | undefined {
  if (!stack?.callFrames?.length) return undefined
  return stack.callFrames
    .map(f => `    at ${f.functionName || '<anonymous>'} (${f.url ?? ''}:${f.lineNumber ?? 0}:${f.columnNumber ?? 0})`)
    .join('\n')
}

function attachConsoleSubscription(client: RawCDPClient): ConsoleSubscription {
  const handlers = new Set<(msg: ConsoleMessage) => void>()

  const emit = (msg: ConsoleMessage): void => {
    for (const h of handlers) {
      try { h(msg) } catch { /* one bad handler shouldn't break others */ }
    }
  }

  const handleConsoleApi = (params: ConsoleAPICalledEvent): void => {
    if (process.env.AV_DEBUG_CONSOLE) {
      // eslint-disable-next-line no-console
      console.error('[av-debug] Runtime.consoleAPICalled:', params.type, params.args?.length)
    }
    const text = params.args.map(formatRemoteObject).filter(Boolean).join(' ')
    emit({
      ts: Date.now(),
      level: levelFromConsoleType(params.type),
      source: ConsoleSource.Runtime,
      text,
      stack: formatStackTrace(params.stackTrace),
    })
  }

  const handleLogEntry = (params: LogEntryAddedEvent): void => {
    if (process.env.AV_DEBUG_CONSOLE) {
      // eslint-disable-next-line no-console
      console.error('[av-debug] Log.entryAdded:', params.entry.level, params.entry.text?.slice(0, 60))
    }
    emit({
      ts: Date.now(),
      level: levelFromLogEntry(params.entry.level),
      source: ConsoleSource.Log,
      text: params.entry.text,
      stack: formatStackTrace(params.entry.stackTrace),
    })
  }

  // chrome-remote-interface event subscription — per-domain shorthand.
  client.Runtime.consoleAPICalled(handleConsoleApi)
  client.Log.entryAdded(handleLogEntry)

  return {
    emit,
    add(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
}

const CDP_RESOURCE_TYPE_MAP: Record<string, NetworkResourceType> = {
  Document: NetworkResourceType.Document,
  Stylesheet: NetworkResourceType.Stylesheet,
  Image: NetworkResourceType.Image,
  Media: NetworkResourceType.Media,
  Font: NetworkResourceType.Font,
  Script: NetworkResourceType.Script,
  TextTrack: NetworkResourceType.TextTrack,
  XHR: NetworkResourceType.Xhr,
  Fetch: NetworkResourceType.Fetch,
  EventSource: NetworkResourceType.EventSource,
  WebSocket: NetworkResourceType.WebSocket,
  Manifest: NetworkResourceType.Manifest,
  Ping: NetworkResourceType.Ping,
  Other: NetworkResourceType.Other,
}

function toResourceType(raw: unknown): NetworkResourceType {
  return (typeof raw === 'string' && CDP_RESOURCE_TYPE_MAP[raw]) || NetworkResourceType.Other
}

function toStringRecord(raw: unknown): Record<string, string> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, string>
  }
  return {}
}

function str(v: unknown): string { return typeof v === 'string' ? v : '' }
function num(v: unknown): number { return typeof v === 'number' ? v : 0 }
function bool(v: unknown): boolean { return typeof v === 'boolean' ? v : false }

function attachNetworkSubscription(network: RawCDPNetwork): NetworkSubscription {
  const handlers = new Set<(ev: NetworkEvent) => void>()
  let networkEnabled = false

  const emit = (ev: NetworkEvent): void => {
    for (const h of handlers) {
      try { h(ev) } catch { /* ignore */ }
    }
  }

  network.requestWillBeSent((p) => {
    emit({
      kind: NetworkEventKind.RequestWillBeSent,
      requestId: str(p['requestId']),
      ts: Date.now(),
      url: str((p['request'] as Record<string, unknown>)?.['url'] ?? p['documentURL']),
      method: str((p['request'] as Record<string, unknown>)?.['method']),
      resourceType: toResourceType(p['type']),
      headers: toStringRecord((p['request'] as Record<string, unknown>)?.['headers']),
      postData: typeof (p['request'] as Record<string, unknown>)?.['postData'] === 'string'
        ? str((p['request'] as Record<string, unknown>)['postData'])
        : undefined,
    })
  })

  network.responseReceived((p) => {
    const response = (p['response'] as Record<string, unknown>) ?? {}
    emit({
      kind: NetworkEventKind.ResponseReceived,
      requestId: str(p['requestId']),
      ts: Date.now(),
      status: num(response['status']),
      statusText: str(response['statusText']),
      headers: toStringRecord(response['headers']),
      mimeType: str(response['mimeType']),
      resourceType: toResourceType(p['type']),
    })
  })

  network.loadingFinished((p) => {
    emit({
      kind: NetworkEventKind.LoadingFinished,
      requestId: str(p['requestId']),
      ts: Date.now(),
      encodedDataLength: num(p['encodedDataLength']),
    })
  })

  network.loadingFailed((p) => {
    emit({
      kind: NetworkEventKind.LoadingFailed,
      requestId: str(p['requestId']),
      ts: Date.now(),
      errorText: str(p['errorText']),
      canceled: bool(p['canceled']),
      resourceType: toResourceType(p['type']),
    })
  })

  network.webSocketCreated((p) => {
    emit({
      kind: NetworkEventKind.WebSocketCreated,
      requestId: str(p['requestId']),
      ts: Date.now(),
      url: str(p['url']),
    })
  })

  network.webSocketFrameSent((p) => {
    const frame = (p['response'] as Record<string, unknown>) ?? {}
    emit({
      kind: NetworkEventKind.WebSocketFrameSent,
      requestId: str(p['requestId']),
      ts: Date.now(),
      opcode: num(frame['opcode']) as WebSocketOpcode,
      payloadData: str(frame['payloadData']),
    })
  })

  network.webSocketFrameReceived((p) => {
    const frame = (p['response'] as Record<string, unknown>) ?? {}
    emit({
      kind: NetworkEventKind.WebSocketFrameReceived,
      requestId: str(p['requestId']),
      ts: Date.now(),
      opcode: num(frame['opcode']) as WebSocketOpcode,
      payloadData: str(frame['payloadData']),
    })
  })

  network.webSocketFrameError((p) => {
    emit({
      kind: NetworkEventKind.WebSocketFrameError,
      requestId: str(p['requestId']),
      ts: Date.now(),
      errorMessage: str(p['errorMessage']),
    })
  })

  network.webSocketClosed((p) => {
    emit({
      kind: NetworkEventKind.WebSocketClosed,
      requestId: str(p['requestId']),
      ts: Date.now(),
    })
  })

  network.eventSourceMessageReceived((p) => {
    emit({
      kind: NetworkEventKind.EventSourceMessageReceived,
      requestId: str(p['requestId']),
      ts: Date.now(),
      eventName: str(p['eventName']),
      data: str(p['data']),
      messageId: str(p['eventId']),
    })
  })

  return {
    add(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    async enable() {
      if (networkEnabled) return
      networkEnabled = true
      await network.enable()
    },
    getResponseBody: (requestId) => network.getResponseBody({ requestId }),
  }
}

async function evaluateImpl(
  client: RawCDPClient,
  expression: string,
  opts: EvaluateOpts | undefined,
): Promise<unknown> {
  const returnByValue = opts?.returnByValue ?? true
  const awaitPromise = opts?.awaitPromise ?? false
  const { result, exceptionDetails } = await client.Runtime.evaluate({
    expression,
    returnByValue,
    awaitPromise,
  })
  if (exceptionDetails) {
    const text = exceptionDetails.exception?.description
      ?? exceptionDetails.text
      ?? 'Evaluation failed'
    throw new EvaluationError(text, exceptionDetails.stackTrace?.description)
  }
  if (returnByValue) return result.value
  return result
}

async function openClient(port: number, target: TargetInfo): Promise<RawCDPClient> {
  const host = targetHostMap.get(`${port}:${target.id}`) ?? 'localhost'
  const connect = CDP({ host, port, target: target.id }) as Promise<RawCDPClient>
  return withTimeout(connect, connectTimeoutMs(), `CDP connect to ${target.type}:${target.id.slice(0, 8)}`)
}

/**
 * A target can accept the WebSocket and then never answer a command — a worker that died
 * between `/json/list` and the handshake does exactly that. Without a bound here the
 * `*.enable` calls hang forever and take the caller (a request, or a log-recorder rescan)
 * with them. The half-open client is closed so a failed bring-up leaks no socket.
 */
async function bringUpSession(client: RawCDPClient, target: TargetInfo, steps: () => Promise<void>): Promise<void> {
  try {
    await withTimeout(steps(), connectTimeoutMs(), `CDP session setup for ${target.type}:${target.id.slice(0, 8)}`)
  } catch (err) {
    try { await client.close() } catch { /* already gone */ }
    throw err
  }
}

/**
 * chrome-remote-interface rejects in-flight commands on `disconnect`, but a
 * cached session over a dead socket would keep serving requests. Sessions
 * expose the event so the owner can evict them.
 */
function attachDisconnectSubscription(client: RawCDPClient): (handler: () => void) => void {
  const handlers = new Set<() => void>()
  let disconnected = false

  client.on('disconnect', () => {
    if (disconnected) return
    disconnected = true
    for (const h of handlers) {
      try { h() } catch { /* one bad handler shouldn't break others */ }
    }
    handlers.clear()
  })

  return (handler) => {
    if (disconnected) {
      handler()
      return
    }
    handlers.add(handler)
  }
}

export async function connectToRuntime(port: number, target: TargetInfo): Promise<RuntimeSession> {
  if (process.env.AV_DEBUG_CONSOLE) {
    // eslint-disable-next-line no-console
    console.error(`[av-debug] connectToRuntime ${target.type}:${target.id.slice(0, 8)}`)
  }
  const client = await openClient(port, target)
  // Subscribe BEFORE enable so we catch buffered messages emitted at enable-time.
  const consoleSub = attachConsoleSubscription(client)
  const networkSub = attachNetworkSubscription(client.Network)
  const onDisconnect = attachDisconnectSubscription(client)
  await bringUpSession(client, target, async () => {
    await client.Runtime.enable()
    await client.Log.enable()
  })

  return {
    target,
    evaluate: (expression, opts) => evaluateImpl(client, expression, opts),
    onDisconnect,
    onConsole: (handler) => consoleSub.add(handler),
    onNetwork: (handler) => networkSub.add(handler),
    enableNetwork: () => networkSub.enable(),
    getResponseBody: (requestId) => networkSub.getResponseBody(requestId),
    async close() {
      await client.close()
    },
  }
}

export async function connectToPage(
  port: number,
  target: TargetInfo,
  cache: AxTreeCache,
): Promise<PageSession> {
  if (target.type !== TargetType.Page && target.type !== TargetType.Iframe) {
    throw new Error(`connectToPage requires a page/iframe target, got: ${target.type}`)
  }
  if (process.env.AV_DEBUG_CONSOLE) {
    // eslint-disable-next-line no-console
    console.error(`[av-debug] connectToPage ${target.type}:${target.id.slice(0, 8)}`)
  }
  const client = await openClient(port, target)
  const { Runtime, Accessibility, Page, DOM, Input } = client as RawCDPClient & {
    Accessibility: { enable: () => Promise<unknown>; getFullAXTree: () => Promise<{ nodes: AXNode[] }>; queryAXTree: (p: Record<string, unknown>) => Promise<{ nodes: AXNode[] }> }
    Page: { enable: () => Promise<unknown>; captureScreenshot: (p?: Record<string, unknown>) => Promise<{ data: string }>; getLayoutMetrics: () => Promise<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>; frameNavigated: (cb: () => void) => unknown }
    DOM: { enable: () => Promise<unknown>; resolveNode: (p: Record<string, unknown>) => Promise<{ object: { objectId: string } }>; getBoxModel: (p: Record<string, unknown>) => Promise<{ model: { content: number[] } }>; focus: (p: Record<string, unknown>) => Promise<unknown>; getDocument: (p: Record<string, unknown>) => Promise<{ root: { backendNodeId: number } }>; requestNode: (p: Record<string, unknown>) => Promise<{ nodeId: number }>; describeNode: (p: Record<string, unknown>) => Promise<{ node: { backendNodeId: number } }> }
    Input: { dispatchMouseEvent: (p: Record<string, unknown>) => Promise<unknown> }
  }
  const cacheKey = `${port}:${target.id}`

  // Subscribe BEFORE enable so we catch buffered console/log entries emitted at enable-time.
  const consoleSub = attachConsoleSubscription(client)
  const networkSub = attachNetworkSubscription(client.Network)
  const onDisconnect = attachDisconnectSubscription(client)
  let documentBackendNodeId = 0
  await bringUpSession(client, target, async () => {
    await Page.enable()
    await DOM.enable()
    await Accessibility.enable()
    await Runtime.enable()
    await client.Log.enable()
    // Fetch document root once — needed as subtree root for Accessibility.queryAXTree
    const { root } = await DOM.getDocument({ depth: 0 })
    documentBackendNodeId = root.backendNodeId
  })

  // null = not yet tested; true = available; false = unavailable (API not supported)
  let queryAXTreeAvailable: boolean | null = null
  // null = not yet tested; true = webp supported; false = not supported (old Chrome/Electron)
  let webpSupported: boolean | null = null

  Page.frameNavigated(async () => {
    cache.invalidate(cacheKey)
    try {
      const { root: newRoot } = await DOM.getDocument({ depth: 0 })
      documentBackendNodeId = newRoot.backendNodeId
    } catch { /* ignore refresh errors — next queryAXTree call will fall back */ }
  })

  async function dispatchClick(x: number, y: number, opts?: ClickOpts): Promise<void> {
    const clicks = Math.max(1, opts?.clicks ?? 1)
    if (clicks === 1) {
      const pressed = Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      const released = Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
      await Promise.all([pressed, released])
      return
    }
    for (let i = 1; i <= clicks; i++) {
      await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: i })
      await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: i })
    }
  }

  async function dispatchDrag(from: Point, to: Point, opts: DragOpts | undefined): Promise<void> {
    const steps = Math.max(0, opts?.steps ?? 10)
    const button = opts?.button ?? MouseButton.Left
    const holdMs = Math.max(0, opts?.holdMs ?? 0)

    await Input.dispatchMouseEvent({ type: 'mousePressed', x: from.x, y: from.y, button, clickCount: 1 })
    if (holdMs > 0) await new Promise(r => setTimeout(r, holdMs))

    for (let i = 1; i <= steps; i++) {
      const t = i / (steps + 1)
      const x = from.x + (to.x - from.x) * t
      const y = from.y + (to.y - from.y) * t
      await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button })
    }
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x: to.x, y: to.y, button })
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: to.x, y: to.y, button, clickCount: 1 })
  }

  async function scrollNodeIntoView(backendNodeId: number): Promise<void> {
    const { object } = await DOM.resolveNode({ backendNodeId })
    await Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: 'function() { this.scrollIntoViewIfNeeded() }',
    })
  }

  async function resolveBoxCenter(backendNodeId: number, scrollIntoView: boolean): Promise<Point> {
    if (scrollIntoView) await scrollNodeIntoView(backendNodeId)
    const { model } = await DOM.getBoxModel({ backendNodeId })
    const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content
    return { x: (x1 + x2 + x3 + x4) / 4, y: (y1 + y2 + y3 + y4) / 4 }
  }

  /**
   * Walk up `levels` element ancestors and return that node's backendNodeId.
   * A filter match usually lands on the text-bearing node (a heading), while the
   * interesting rect is its container.
   */
  async function resolveAncestor(backendNodeId: number, levels: number): Promise<number> {
    const { object } = await DOM.resolveNode({ backendNodeId })
    const climbed = await Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: `function(levels) {
        let el = this.nodeType === Node.TEXT_NODE ? this.parentElement : this;
        for (let i = 0; i < levels && el.parentElement; i++) el = el.parentElement;
        return el;
      }`,
      arguments: [{ value: levels }],
    }) as { result?: { objectId?: string } }
    const ancestorObjectId = climbed.result?.objectId
    if (!ancestorObjectId) return backendNodeId
    const { nodeId } = await DOM.requestNode({ objectId: ancestorObjectId })
    const { node } = await DOM.describeNode({ nodeId })
    return node.backendNodeId
  }

  async function resolveBoxRect(backendNodeId: number, scrollIntoView: boolean): Promise<ScreenshotClip> {
    if (scrollIntoView) await scrollNodeIntoView(backendNodeId)
    const { model } = await DOM.getBoxModel({ backendNodeId })
    const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content
    const xs = [x1, x2, x3, x4]
    const ys = [y1, y2, y3, y4]
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY }
  }

  return {
    target,

    evaluate: (expression, opts) => evaluateImpl(client, expression, opts),
    onDisconnect,
    onConsole: (handler) => consoleSub.add(handler),
    onNetwork: (handler) => networkSub.add(handler),
    enableNetwork: () => networkSub.enable(),
    getResponseBody: (requestId) => networkSub.getResponseBody(requestId),

    async getAccessibilityTree(): Promise<AXNode[]> {
      const cached = cache.get(cacheKey)
      if (cached) return cached
      const { nodes } = await Accessibility.getFullAXTree()
      cache.set(cacheKey, nodes)
      return nodes
    },

    async getAccessibilityTreeMeta(): Promise<{ nodes: AXNode[]; fromCache: boolean }> {
      const meta = cache.getWithMeta(cacheKey)
      if (meta.found) {
        return { nodes: meta.nodes, fromCache: true }
      }
      const { nodes } = await Accessibility.getFullAXTree()
      cache.set(cacheKey, nodes)
      return { nodes, fromCache: false }
    },

    async queryAXTree({ accessibleName, role }: { accessibleName?: string; role?: string }): Promise<AXNode[] | null> {
      if (queryAXTreeAvailable === false) return null
      try {
        const { nodes } = await Accessibility.queryAXTree({
          backendNodeId: documentBackendNodeId,
          accessibleName,
          role,
        })
        queryAXTreeAvailable = true
        return nodes
      } catch {
        queryAXTreeAvailable = false
        return null
      }
    },

    async captureScreenshot(opts?: ScreenshotOpts): Promise<{ buffer: Buffer; format: 'png' | 'jpeg' | 'webp' }> {
      const scale = opts?.scale ?? 1
      const explicitClip = opts?.clip

      if (explicitClip !== undefined) {
        const format = scale < 1 ? 'jpeg' : 'png'
        const params: Record<string, unknown> = { format, clip: { ...explicitClip, scale } }
        if (format === 'jpeg') params.quality = 80
        const { data } = await Page.captureScreenshot(params)
        return { buffer: Buffer.from(data, 'base64'), format }
      }

      if (scale >= 1) {
        const { data } = await Page.captureScreenshot({ format: 'png' })
        return { buffer: Buffer.from(data, 'base64'), format: 'png' }
      }

      const { cssLayoutViewport } = await Page.getLayoutMetrics()
      const clip = { x: 0, y: 0, width: cssLayoutViewport.clientWidth, height: cssLayoutViewport.clientHeight, scale }

      if (webpSupported !== false) {
        try {
          const { data } = await Page.captureScreenshot({ format: 'webp', quality: 80, clip })
          webpSupported = true
          return { buffer: Buffer.from(data, 'base64'), format: 'webp' }
        } catch {
          if (webpSupported === null) {
            // eslint-disable-next-line no-console
            console.error('[agent-view] WebP not supported by this Chrome/Electron version, falling back to JPEG')
            webpSupported = false
          }
        }
      }

      const { data } = await Page.captureScreenshot({ format: 'jpeg', quality: 80, clip })
      return { buffer: Buffer.from(data, 'base64'), format: 'jpeg' }
    },

    async clickByNodeId(backendNodeId: number, opts?: ClickOpts): Promise<void> {
      const { x, y } = await resolveBoxCenter(backendNodeId, true)
      await dispatchClick(x, y, opts)
    },

    async clickAtPosition(x: number, y: number, opts?: ClickOpts): Promise<void> {
      await dispatchClick(x, y, opts)
    },

    async getBoxCenter(backendNodeId: number, opts?: { scrollIntoView?: boolean }): Promise<Point> {
      return resolveBoxCenter(backendNodeId, opts?.scrollIntoView ?? true)
    },

    async getBoxRect(backendNodeId: number, opts?: { scrollIntoView?: boolean; ancestorLevels?: number }): Promise<ScreenshotClip> {
      const levels = opts?.ancestorLevels ?? 0
      const nodeId = levels > 0 ? await resolveAncestor(backendNodeId, levels) : backendNodeId
      return resolveBoxRect(nodeId, opts?.scrollIntoView ?? true)
    },

    async dragBetweenPositions(from: Point, to: Point, opts?: DragOpts): Promise<void> {
      await dispatchDrag(from, to, opts)
    },

    async fillByNodeId(backendNodeId: number, value: string): Promise<void> {
      const { object } = await DOM.resolveNode({ backendNodeId })
      await DOM.focus({ backendNodeId })
      await Runtime.callFunctionOn({
        objectId: object.objectId,
        functionDeclaration: `function(val) {
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          if (nativeSetter) nativeSetter.call(this, val);
          else this.value = val;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`,
        arguments: [{ value }],
      })
    },

    async close(): Promise<void> {
      await client.close()
    },
  }
}
