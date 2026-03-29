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
  const { Runtime, Accessibility, Page } = client

  await Page.enable()
  await Accessibility.enable()

  return {
    async evaluate(expression: string): Promise<unknown> {
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

    async close(): Promise<void> {
      await client.close()
    },
  }
}
