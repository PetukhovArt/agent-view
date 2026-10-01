import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PageSession } from '../cdp/types.js'
import { runAct } from './act-session.js'

const NODE_ID = 7

describe('runAct', () => {
  const app = (name = 'Индикатор') => {
    const conn = {
      evaluate: async () => '',
      getAccessibilityTree: async () => [{ nodeId: 'ax7', role: { value: 'button' }, name: { value: name }, backendDOMNodeId: NODE_ID }],
      getLayoutSnapshot: async () => ({
        viewport: { width: 800, height: 600 },
        nodes: new Map([[NODE_ID, { rect: { x: 10, y: 10, width: 100, height: 20 }, tag: 'button', attributes: {}, cursor: 'pointer' }]]),
      }),
      hitTest: async () => null,
      // The until shows once the row was clicked.
      queryVisible: async () => (conn.clickByNodeId.mock.calls.length ? { backendDOMNodeId: 1, count: 1 } : { backendDOMNodeId: null, count: 0 }),
      clickByNodeId: vi.fn(async () => {}),
    }
    const deps = { conn: conn as unknown as PageSession, invalidateAxCache: () => {}, reconnect: async () => deps.conn }
    return { conn, deps, holder: { act: null }, cwd: mkdtempSync(join(tmpdir(), 'av-act-')) }
  }

  it('records a ctrl-click and replays it with ctrl held', async () => {
    const { conn, deps, holder, cwd } = app()

    await runAct(holder, { op: 'start', untilTestid: 'selected', save: 'pick', in: 'tree', cwd }, deps)
    const recorded = await runAct(holder, { op: 'click', target: '1', modifiers: 'ctrl' }, deps)
    const replayed = await runAct(holder, { op: 'replay', name: 'pick', cwd }, deps)

    expect(recorded).toMatchObject({ ok: true, data: expect.stringMatching(/^DONE: .* saved /) })
    expect(replayed).toMatchObject({ ok: true, exitCode: 0 })
    expect(conn.clickByNodeId.mock.calls).toEqual([[NODE_ID, { modifiers: ['ctrl'] }], [NODE_ID, { modifiers: ['ctrl'] }]])
  })

  it('refuses to save a step marked from a uuid parameter value, though the saved strings hold only ${ROW}', async () => {
    const uuid = '7a1e0b52-1111-4c2a-9a01-000000000001'
    const { deps, holder, cwd } = app(`Насос ${uuid}`)

    await runAct(holder, { op: 'start', untilTestid: 'selected', save: 'pick', in: 'tree', params: [`ROW=${uuid}`], cwd }, deps)
    const recorded = await runAct(holder, { op: 'click', target: '1' }, deps)

    expect(recorded).toMatchObject({ ok: true, data: expect.stringMatching(/saved .*uuid/) })
  })
})
