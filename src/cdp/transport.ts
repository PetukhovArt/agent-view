// @ts-expect-error no types available for chrome-remote-interface
import CDP from 'chrome-remote-interface'
import {
  TargetType,
  ConsoleLevel,
  ConsoleSource,
  EvaluationError,
  type CDPTarget,
  type AXNode,
  type ScreenshotOpts,
  type TargetInfo,
  type RuntimeSession,
  type PageSession,
  type ConsoleMessage,
  type EvaluateOpts,
} from './types.js'
import type { AxTreeCache } from './ax-cache.js'

// CDP hosts to try: IPv4 first, then IPv6 (WebView2/Tauri often listens on ::1)
const CDP_HOSTS = ['127.0.0.1', '::1'] as const

// Maps targetId → host for connection routing
const targetHostMap = new Map<string, string>()

const KNOWN_TARGET_TYPES: ReadonlySet<string> = new Set(Object.values(TargetType))

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
      const targets = await CDP.List({ host, port })
      for (const t of targets as CDPTarget[]) {
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
  return await CDP({ host, port, target: target.id }) as RawCDPClient
}

export async function connectToRuntime(port: number, target: TargetInfo): Promise<RuntimeSession> {
  if (process.env.AV_DEBUG_CONSOLE) {
    // eslint-disable-next-line no-console
    console.error(`[av-debug] connectToRuntime ${target.type}:${target.id.slice(0, 8)}`)
  }
  const client = await openClient(port, target)
  // Subscribe BEFORE enable so we catch buffered messages emitted at enable-time.
  const consoleSub = attachConsoleSubscription(client)
  await client.Runtime.enable()
  await client.Log.enable()

  return {
    target,
    evaluate: (expression, opts) => evaluateImpl(client, expression, opts),
    onConsole: (handler) => consoleSub.add(handler),
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
    DOM: { enable: () => Promise<unknown>; resolveNode: (p: Record<string, unknown>) => Promise<{ object: { objectId: string } }>; getBoxModel: (p: Record<string, unknown>) => Promise<{ model: { content: number[] } }>; focus: (p: Record<string, unknown>) => Promise<unknown>; getDocument: (p: Record<string, unknown>) => Promise<{ root: { backendNodeId: number } }> }
    Input: { dispatchMouseEvent: (p: Record<string, unknown>) => Promise<unknown> }
  }
  const cacheKey = `${port}:${target.id}`

  // Subscribe BEFORE enable so we catch buffered console/log entries emitted at enable-time.
  const consoleSub = attachConsoleSubscription(client)
  await Page.enable()
  await DOM.enable()
  await Accessibility.enable()
  await Runtime.enable()
  await client.Log.enable()

  // Fetch document root once — needed as subtree root for Accessibility.queryAXTree
  const { root } = await DOM.getDocument({ depth: 0 })
  let documentBackendNodeId: number = root.backendNodeId

  // null = not yet tested; true = available; false = unavailable (API not supported)
  let queryAXTreeAvailable: boolean | null = null

  Page.frameNavigated(async () => {
    cache.invalidate(cacheKey)
    try {
      const { root: newRoot } = await DOM.getDocument({ depth: 0 })
      documentBackendNodeId = newRoot.backendNodeId
    } catch { /* ignore refresh errors — next queryAXTree call will fall back */ }
  })

  async function dispatchClick(x: number, y: number): Promise<void> {
    const pressed = Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    const released = Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await Promise.all([pressed, released])
  }

  return {
    target,

    evaluate: (expression, opts) => evaluateImpl(client, expression, opts),
    onConsole: (handler) => consoleSub.add(handler),

    async getAccessibilityTree(): Promise<AXNode[]> {
      const cached = cache.get(cacheKey)
      if (cached) return cached
      const { nodes } = await Accessibility.getFullAXTree()
      cache.set(cacheKey, nodes)
      return nodes
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

    async captureScreenshot(opts?: ScreenshotOpts): Promise<Buffer> {
      const scale = opts?.scale ?? 1
      if (scale >= 1) {
        const { data } = await Page.captureScreenshot({ format: 'png' })
        return Buffer.from(data, 'base64')
      }
      const { cssLayoutViewport } = await Page.getLayoutMetrics()
      const { data } = await Page.captureScreenshot({
        format: 'jpeg',
        quality: 80,
        clip: { x: 0, y: 0, width: cssLayoutViewport.clientWidth, height: cssLayoutViewport.clientHeight, scale },
      })
      return Buffer.from(data, 'base64')
    },

    async clickByNodeId(backendNodeId: number): Promise<void> {
      const [{ object }, { model }] = await Promise.all([
        DOM.resolveNode({ backendNodeId }),
        DOM.getBoxModel({ backendNodeId }),
      ])
      await Runtime.callFunctionOn({
        objectId: object.objectId,
        functionDeclaration: 'function() { this.scrollIntoViewIfNeeded() }',
      })
      const [x1, y1, x2, y2, x3, y3, x4, y4] = model.content
      const cx = (x1 + x2 + x3 + x4) / 4
      const cy = (y1 + y2 + y3 + y4) / 4
      await dispatchClick(cx, cy)
    },

    async clickAtPosition(x: number, y: number): Promise<void> {
      await dispatchClick(x, y)
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
