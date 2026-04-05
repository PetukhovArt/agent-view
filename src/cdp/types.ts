export type CDPTarget = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl: string
}

export type CDPConnection = {
  getAccessibilityTree: () => Promise<AXNode[]>
  captureScreenshot: () => Promise<Buffer>
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
