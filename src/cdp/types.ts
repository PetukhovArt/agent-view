export type CDPTarget = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl: string
}

export type ScreenshotOpts = {
  /** Scale factor (0 < scale ≤ 1). Values < 1 use JPEG at 80% quality to reduce token cost. */
  scale?: number
}

export type CDPConnection = {
  getAccessibilityTree: () => Promise<AXNode[]>
  /** Returns matching nodes by accessible name/role. null = API unavailable; [] = no match. */
  queryAXTree: (params: { accessibleName?: string; role?: string }) => Promise<AXNode[] | null>
  captureScreenshot: (opts?: ScreenshotOpts) => Promise<Buffer>
  clickByNodeId: (backendNodeId: number) => Promise<void>
  clickAtPosition: (x: number, y: number) => Promise<void>
  fillByNodeId: (backendNodeId: number, value: string) => Promise<void>
  /** Executes arbitrary JS in the target process. Only pass trusted, hardcoded expressions. */
  evaluate: (js: string) => Promise<unknown>
  close: () => Promise<void>
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
