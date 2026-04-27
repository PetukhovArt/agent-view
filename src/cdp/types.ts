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
  /** Scale factor (0 < scale ≤ 1). Values < 1 use JPEG at 80% quality to reduce token cost. */
  scale?: number
  /** Crop to this rect before capturing. Combined with scale when both are set. */
  clip?: ScreenshotClip
}

export enum MouseButton {
  Left = 'left',
  Right = 'right',
  Middle = 'middle',
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
  /** Subscribe to normalized console events. Returns disposer. Multiple subscribers share the underlying CDP subscription. */
  onConsole: (handler: (msg: ConsoleMessage) => void) => () => void
  close: () => Promise<void>
}

export type PageSession = RuntimeSession & {
  getAccessibilityTree: () => Promise<AXNode[]>
  /** Returns matching nodes by accessible name/role. null = API unavailable; [] = no match. */
  queryAXTree: (params: { accessibleName?: string; role?: string }) => Promise<AXNode[] | null>
  captureScreenshot: (opts?: ScreenshotOpts) => Promise<Buffer>
  clickByNodeId: (backendDOMNodeId: number) => Promise<void>
  clickAtPosition: (x: number, y: number) => Promise<void>
  fillByNodeId: (backendDOMNodeId: number, value: string) => Promise<void>
  /** Resolve box-model center for an element. `scrollIntoView` defaults to true. */
  getBoxCenter: (backendDOMNodeId: number, opts?: { scrollIntoView?: boolean }) => Promise<Point>
  /** Resolve axis-aligned bounding rect for an element. `scrollIntoView` defaults to true. */
  getBoxRect: (backendDOMNodeId: number, opts?: { scrollIntoView?: boolean }) => Promise<ScreenshotClip>
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
