// @ts-expect-error no types available for chrome-remote-interface
import CDP from 'chrome-remote-interface'
import type { CDPConnection, CDPTarget, AXNode } from './types.js'

export async function listTargets(port: number): Promise<CDPTarget[]> {
  try {
    const targets = await CDP.List({ host: '127.0.0.1', port })
    return targets as CDPTarget[]
  } catch {
    return []
  }
}

export async function connectToTarget(port: number, targetId: string): Promise<CDPConnection> {
  const client = await CDP({ host: '127.0.0.1', port, target: targetId })
  const { Runtime, Accessibility, Page, DOM, Input } = client

  await Page.enable()
  await DOM.enable()
  await Accessibility.enable()

  async function dispatchClick(x: number, y: number): Promise<void> {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  return {
    async evaluateScene(expression: string): Promise<unknown> {
      const { result } = await Runtime.evaluate({
        expression,
        returnByValue: true,
      })
      return result.value
    },

    async getAccessibilityTree(): Promise<AXNode[]> {
      const { nodes } = await Accessibility.getFullAXTree()
      return nodes as AXNode[]
    },

    async captureScreenshot(): Promise<Buffer> {
      const { data } = await Page.captureScreenshot({ format: 'png' })
      return Buffer.from(data, 'base64')
    },

    async clickByNodeId(backendNodeId: number): Promise<void> {
      const { object } = await DOM.resolveNode({ backendNodeId })
      await Runtime.callFunctionOn({
        objectId: object.objectId,
        functionDeclaration: 'function() { this.scrollIntoViewIfNeeded() }',
      })
      const { model } = await DOM.getBoxModel({ backendNodeId })
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
