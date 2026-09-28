import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MouseButton, type PageSession } from '../cdp/types.js'
import { writeScript, type ClickOp } from './act-script.js'
import { replay } from './act-replay.js'

const NODE_ID = 7

/** A window with one on-screen, uncovered button; the until element is always visible. */
const fakeConn = () => ({
  getAccessibilityTree: async () => [{ nodeId: 'ax7', role: { value: 'button' }, name: { value: 'Сцена' }, backendDOMNodeId: NODE_ID }],
  getLayoutSnapshot: async () => ({
    viewport: { width: 800, height: 600 },
    nodes: new Map([[NODE_ID, { rect: { x: 10, y: 10, width: 100, height: 20 }, tag: 'button', attributes: {}, cursor: 'pointer' }]]),
  }),
  hitTest: async () => null,
  queryVisible: async () => ({ backendDOMNodeId: 1, count: 1 }),
  clickByNodeId: vi.fn(async () => {}),
})

describe('replay', () => {
  it.each<[ClickOp, object]>([
    ['click', {}],
    ['dblclick', { clicks: 2 }],
    ['rightclick', { button: MouseButton.Right }],
  ])('replays a recorded %s as that click', async (op, opts) => {
    const store = mkdtempSync(join(tmpdir(), 'av-replay-'))
    const step = { op, target: { role: 'button', name: 'Сцена' }, isPassword: false }
    await writeScript(store, 'open', { until: { testid: 'done' }, steps: [step] })
    const conn = fakeConn()
    const deps = { conn: conn as unknown as PageSession, invalidateAxCache: () => {}, reconnect: async () => deps.conn }

    const result = await replay({ store, name: 'open' }, deps)

    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(conn.clickByNodeId).toHaveBeenCalledExactlyOnceWith(NODE_ID, opts)
  })
})
