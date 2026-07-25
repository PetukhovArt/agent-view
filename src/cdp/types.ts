export type CDPTarget = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

export enum TargetType {
  Page = 'page',
  Iframe = 'iframe',
  SharedWorker = 'shared_worker',
  ServiceWorker = 'service_worker',
  Worker = 'worker',
}

export type TargetInfo = {
  id: string
  type: TargetType
  title: string
  url: string
}

export type ScreenshotClip = {
  x: number
  y: number
  width: number
  height: number
}

export type ScreenshotOpts = {
  /** Scale factor (0 < scale ≤ 1). Values < 1 use WebP at q=80 (JPEG fallback for old Chrome/Electron). */
  scale?: number
  /** Crop to this rect before capturing. Combined with scale when both are set. */
  clip?: ScreenshotClip
}

export type ScreenshotResult = {
  buffer: Buffer
  format: 'png' | 'jpeg' | 'webp'
}

export enum MouseButton {
  Left = 'left',
  Right = 'right',
  Middle = 'middle',
}

export type ClickOpts = {
  /** Number of clicks at the same position (1 = single, 2 = double-click). Default 1. */
  clicks?: number
}

export type DragOpts = {
  /** Number of intermediate `mouseMoved` events between press and release. Default 10. */
  steps?: number
  button?: MouseButton
  /** Pause between `mousePressed` and the first `mouseMoved`, in ms. Some libs require >100ms. */
  holdMs?: number
}

export type Point = { x: number; y: number }

export enum ConsoleLevel {
  Log = 'log',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
  Debug = 'debug',
}

export enum ConsoleSource {
  Runtime = 'runtime',
  Log = 'log',
}

export type ConsoleMessage = {
  ts: number
  level: ConsoleLevel
  source: ConsoleSource
  text: string
  stack?: string
}

export type EvaluateOpts = {
  awaitPromise?: boolean
  /** When true, return the raw RemoteObject instead of unwrapped value. Used by the eval CLI to format DOM nodes etc. */
  returnByValue?: boolean
}

export class EvaluationError extends Error {
  constructor(message: string, public readonly stack?: string) {
    super(message)
    this.name = 'EvaluationError'
  }
}

export type RuntimeSession = {
  readonly target: TargetInfo
  /**
   * Run JS in the target. Returns the unwrapped value (returnByValue: true by default).
   * Throws `EvaluationError` if the script throws or has a syntax error.
   * Only pass trusted, hardcoded expressions or expressions explicitly authorized via `allowEval`.
   */
  evaluate: (expression: string, opts?: EvaluateOpts) => Promise<unknown>
  /**
   * Fires once when the CDP WebSocket drops (target closed, app exited). Registering
   * after the drop invokes the handler immediately — a session over a dead socket must
   * never stay cached.
   */
  onDisconnect: (handler: () => void) => void
  /** Subscribe to normalized console events. Returns disposer. Multiple subscribers share the underlying CDP subscription. */
  onConsole: (handler: (msg: ConsoleMessage) => void) => () => void
  /** Subscribe to normalized CDP `Network.*` events. Returns disposer. Subscribe BEFORE `enableNetwork` to avoid losing events. */
  onNetwork: (handler: (ev: NetworkEvent) => void) => () => void
  /** Idempotent `Network.enable`. Capture is opt-in per session — only call once a subscriber is registered. */
  enableNetwork: () => Promise<void>
  /** `Network.getResponseBody`. Valid only after `loadingFinished` and before buffer eviction. */
  getResponseBody: (requestId: string) => Promise<{ body: string; base64Encoded: boolean }>
  close: () => Promise<void>
}

export type PageSession = RuntimeSession & {
  getAccessibilityTree: () => Promise<AXNode[]>
  /** Same as getAccessibilityTree but also signals whether nodes came from the AX tree cache. */
  getAccessibilityTreeMeta: () => Promise<{ nodes: AXNode[]; fromCache: boolean }>
  /** Returns matching nodes by accessible name/role. null = API unavailable; [] = no match. */
  queryAXTree: (params: { accessibleName?: string; role?: string }) => Promise<AXNode[] | null>
  captureScreenshot: (opts?: ScreenshotOpts) => Promise<ScreenshotResult>
  clickByNodeId: (backendDOMNodeId: number, opts?: ClickOpts) => Promise<void>
  clickAtPosition: (x: number, y: number, opts?: ClickOpts) => Promise<void>
  fillByNodeId: (backendDOMNodeId: number, value: string) => Promise<void>
  /** Resolve box-model center for an element. `scrollIntoView` defaults to true. */
  getBoxCenter: (backendDOMNodeId: number, opts?: { scrollIntoView?: boolean }) => Promise<Point>
  /**
   * Resolve axis-aligned bounding rect for an element. `scrollIntoView` defaults to true.
   * `ancestorLevels` climbs that many element ancestors first — a text match's rect is
   * the text line, not the container it lives in.
   */
  getBoxRect: (backendDOMNodeId: number, opts?: { scrollIntoView?: boolean; ancestorLevels?: number }) => Promise<ScreenshotClip>
  /** CDP-level mouse drag: press → N × move → release. */
  dragBetweenPositions: (from: Point, to: Point, opts?: DragOpts) => Promise<void>
}

export type AXNode = {
  nodeId: string
  role: { value: string }
  name?: { value: string }
  childIds?: string[]
  backendDOMNodeId?: number
  properties?: AXProperty[]
}

export type AXProperty = {
  name: string
  value: { type: string; value?: unknown }
}

// ── Network capture ──────────────────────────────────────────────────────────

/** Normalized CDP `Network.Page.ResourceType`. Unknown CDP types map to `Other`. */
export enum NetworkResourceType {
  Document = 'document',
  Stylesheet = 'stylesheet',
  Image = 'image',
  Media = 'media',
  Font = 'font',
  Script = 'script',
  TextTrack = 'texttrack',
  Xhr = 'xhr',
  Fetch = 'fetch',
  EventSource = 'eventsource',
  WebSocket = 'websocket',
  Manifest = 'manifest',
  Ping = 'ping',
  Other = 'other',
}

/** Lifecycle of one request. `Pending` until it finishes or fails. */
export enum NetworkEntryState {
  Pending = 'pending',
  Complete = 'complete',
  Failed = 'failed',
}

/** RFC 6455 frame opcodes. */
export enum WebSocketOpcode {
  Continuation = 0,
  Text = 1,
  Binary = 2,
  Close = 8,
  Ping = 9,
  Pong = 10,
}

export enum WebSocketDirection {
  Sent = 'sent',
  Received = 'received',
}

export type WebSocketFrame = {
  direction: WebSocketDirection
  opcode: WebSocketOpcode
  ts: number
  /** Payload byte size before per-frame capping. */
  size: number
  /** Capped payload text. Omitted for binary frames (see `binary`). */
  payload?: string
  binary?: boolean
  /** Set on the synthetic frame standing in for `webSocketClosed` / `webSocketFrameError`. */
  terminal?: 'closed' | 'error'
  errorMessage?: string
}

export type NetworkBody = {
  /** Capped text, or empty for binary. */
  text: string
  base64: boolean
  /** Original byte size before capping. */
  size: number
  binary: boolean
}

/** One captured request/connection. HTTP, WebSocket, and EventSource share this shape. */
export type NetworkEntry = {
  requestId: string
  url: string
  method?: string
  resourceType: NetworkResourceType
  state: NetworkEntryState
  status?: number
  statusText?: string
  mimeType?: string
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string>
  startTs: number
  endTs?: number
  totalMs?: number
  /** Time to first byte: responseReceived − request, in ms. */
  ttfbMs?: number
  encodedDataLength?: number
  /** Request payload (`postData`). Captured only when `captureBody`. */
  requestBody?: string
  /** Response body. Captured only when `captureBody`. */
  responseBody?: NetworkBody
  errorText?: string
  canceled?: boolean
  isWebSocket?: boolean
  isEventSource?: boolean
  /** WebSocket/EventSource frame log, bounded per connection. */
  frames?: WebSocketFrame[]
}

/** Discriminator for `NetworkEvent`. */
export enum NetworkEventKind {
  RequestWillBeSent = 'requestWillBeSent',
  ResponseReceived = 'responseReceived',
  LoadingFinished = 'loadingFinished',
  LoadingFailed = 'loadingFailed',
  WebSocketCreated = 'webSocketCreated',
  WebSocketFrameSent = 'webSocketFrameSent',
  WebSocketFrameReceived = 'webSocketFrameReceived',
  WebSocketFrameError = 'webSocketFrameError',
  WebSocketClosed = 'webSocketClosed',
  EventSourceMessageReceived = 'eventSourceMessageReceived',
}

/** Normalized CDP `Network.*` event emitted by the transport subscription. */
export type NetworkEvent =
  | { kind: NetworkEventKind.RequestWillBeSent; requestId: string; ts: number; url: string; method: string; resourceType: NetworkResourceType; headers: Record<string, string>; postData?: string }
  | { kind: NetworkEventKind.ResponseReceived; requestId: string; ts: number; status: number; statusText: string; headers: Record<string, string>; mimeType: string; resourceType: NetworkResourceType }
  | { kind: NetworkEventKind.LoadingFinished; requestId: string; ts: number; encodedDataLength: number }
  | { kind: NetworkEventKind.LoadingFailed; requestId: string; ts: number; errorText: string; canceled: boolean; resourceType: NetworkResourceType }
  | { kind: NetworkEventKind.WebSocketCreated; requestId: string; ts: number; url: string }
  | { kind: NetworkEventKind.WebSocketFrameSent; requestId: string; ts: number; opcode: WebSocketOpcode; payloadData: string }
  | { kind: NetworkEventKind.WebSocketFrameReceived; requestId: string; ts: number; opcode: WebSocketOpcode; payloadData: string }
  | { kind: NetworkEventKind.WebSocketFrameError; requestId: string; ts: number; errorMessage: string }
  | { kind: NetworkEventKind.WebSocketClosed; requestId: string; ts: number }
  | { kind: NetworkEventKind.EventSourceMessageReceived; requestId: string; ts: number; eventName: string; data: string; messageId: string }

export type NetworkFilter = {
  targetId?: string
  since?: number
  /** Substring, or glob when it contains `*`. Matched case-insensitively against the URL. */
  url?: string
  method?: ReadonlySet<string>
  /** Status leading digit, e.g. 4 matches 4xx. */
  statusClasses?: ReadonlySet<number>
  /** Exact status codes, e.g. 404. */
  statusCodes?: ReadonlySet<number>
  /** Match failed requests (CORS block, connection refused — no HTTP status). The `failed` status token. */
  includeFailed?: boolean
  type?: ReadonlySet<NetworkResourceType>
}
