// @ts-expect-error no types available for chrome-remote-interface
import CDP from 'chrome-remote-interface'
import type { CDPConnection, CDPTarget, AXNode, ScreenshotOpts } from './types.js'
import type { AxTreeCache } from './ax-cache.js'

// CDP hosts to try: IPv4 first, then IPv6 (WebView2/Tauri often listens on ::1)
const CDP_HOSTS = ['127.0.0.1', '::1'] as const

// Maps targetId → host for connection routing
const targetHostMap = new Map<string, string>()

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

export async function connectToTarget(port: number, targetId: string, cache: AxTreeCache): Promise<CDPConnection> {
  const host = targetHostMap.get(`${port}:${targetId}`) ?? 'localhost'
  const client = await CDP({ host, port, target: targetId })
  const { Runtime, Accessibility, Page, DOM, Input } = client
  const cacheKey = `${port}:${targetId}`

  await Page.enable()
  await DOM.enable()
  await Accessibility.enable()

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
    // Send both events before awaiting either — browser processes WS messages in order,
    // so mouseReleased always follows mousePressed in the event queue (same as Playwright).
    const pressed = Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    const released = Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await Promise.all([pressed, released])
  }

  return {
    async evaluate(expression: string): Promise<unknown> {
      const { result } = await Runtime.evaluate({
        expression,
        returnByValue: true,
      })
      return result.value
    },

    async getAccessibilityTree(): Promise<AXNode[]> {
      const cached = cache.get(cacheKey)
      if (cached) return cached
      const { nodes } = await Accessibility.getFullAXTree()
      const result = nodes as AXNode[]
      cache.set(cacheKey, result)
      return result
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
        return nodes as AXNode[]
      } catch {
        // API unavailable (Chromium < M86 or Electron < 11)
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
      // Batch 1: resolveNode (needed for scroll) and getBoxModel (independent) run in parallel
      const [{ object }, { model }] = await Promise.all([
        DOM.resolveNode({ backendNodeId }),
        DOM.getBoxModel({ backendNodeId }),
      ])
      // Batch 2: scroll into view (needs objectId from batch 1)
      await Runtime.callFunctionOn({
        objectId: object.objectId,
        functionDeclaration: 'function() { this.scrollIntoViewIfNeeded() }',
      })
      // Batch 3: fire-and-forget mouse events (see dispatchClick)
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
      // Set value and dispatch input/change events for framework reactivity
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
