export type CDPTarget = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl: string
}

export type CDPConnection = {
  evaluate: (expression: string) => Promise<unknown>
  getAccessibilityTree: () => Promise<AXNode[]>
  captureScreenshot: () => Promise<Buffer>
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
