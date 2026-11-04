import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { PageSession } from '../cdp/types.js'
import { runAct } from './act-session.js'

const NODE_ID = 7

describe('runAct', () => {
  const app = (name = 'Индикатор', role = 'button') => {
    const conn = {
      evaluate: vi.fn(async (_expression: string, _opts?: object): Promise<unknown> => ''),
      getAccessibilityTree: async () => [{ nodeId: 'ax7', role: { value: role }, name: { value: name }, backendDOMNodeId: NODE_ID }],
      getLayoutSnapshot: async () => ({
        viewport: { width: 800, height: 600 },
        nodes: new Map([[NODE_ID, { rect: { x: 10, y: 10, width: 100, height: 20 }, tag: 'button', attributes: {}, cursor: 'pointer' }]]),
      }),
      hitTest: async () => null,
      outOfProcessFrames: async () => [],
      // The until shows once the row was clicked.
      queryVisible: async () => (conn.clickByNodeId.mock.calls.length ? { backendDOMNodeId: 1, count: 1 } : { backendDOMNodeId: null, count: 0 }),
      clickByNodeId: vi.fn(async () => {}),
    }
    const deps = { conn: conn as unknown as PageSession, invalidateAxCache: () => {}, reconnect: async () => deps.conn, isEvalAllowed: false }
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

  it('records keys aimed at a row and replays them at that row', async () => {
    const { conn, deps, holder, cwd } = app()
    const pressKeys = vi.fn(async (_chords: unknown, _opts?: { nodeId?: number }) => {})
    // The until shows once the keys went out.
    Object.assign(conn, { pressKeys, queryVisible: async () => (pressKeys.mock.calls.length ? { backendDOMNodeId: 1, count: 1 } : { backendDOMNodeId: null, count: 0 }) })

    await runAct(holder, { op: 'start', untilTestid: 'undone', cwd }, deps)
    const recorded = await runAct(holder, { op: 'key', keys: 'ctrl+z', target: '1' }, deps)
    await runAct(holder, { op: 'save', name: 'undo', in: 'editor', cwd }, deps)
    const replayed = await runAct(holder, { op: 'replay', name: 'undo', cwd }, deps)

    expect(recorded).toMatchObject({ ok: true, data: expect.stringMatching(/^DONE: /) })
    expect(replayed).toMatchObject({ ok: true, exitCode: 0 })
    const presses = pressKeys.mock.calls.map(([chords, opts]) => [(chords as { def: { key: string } }[]).map(c => c.def.key), opts])
    expect(presses).toEqual([[['z'], { nodeId: NODE_ID }], [['z'], { nodeId: NODE_ID }]])
  })

  it('types a number into a slider row, as a native range input takes it', async () => {
    const { conn, deps, holder, cwd } = app('Непрозрачность', 'slider')
    const fillByNodeId = vi.fn(async (_nodeId: number, _value: string) => {})
    Object.assign(conn, { fillByNodeId })

    await runAct(holder, { op: 'start', untilTestid: 'never', cwd }, deps)
    const typed = await runAct(holder, { op: 'type', n: 1, text: '0.5' }, deps)

    expect(typed).toMatchObject({ ok: true, data: expect.stringMatching(/^✓ type \[1\] slider/) })
    expect(fillByNodeId).toHaveBeenCalledExactlyOnceWith(NODE_ID, '0.5')
  })

  it('refuses a uuid parameter value at start --save, before a run that could not be saved', async () => {
    const { deps, holder, cwd } = app()

    const started = await runAct(holder, { op: 'start', untilTestid: 'selected', save: 'pick', in: 'tree', params: ['ROW=7a1e0b52-1111-4c2a-9a01-000000000001'], cwd }, deps)

    expect(started).toMatchObject({ ok: false, error: expect.stringContaining('uuid') })
    expect(holder.act).toBeNull()
  })

  it('refuses an expression until or wait while allowEval is off, running none of its JS', async () => {
    const { conn, deps, holder, cwd } = app()

    const until = await runAct(holder, { op: 'start', untilExpr: 'window.ready', cwd }, deps)
    await runAct(holder, { op: 'start', untilTestid: 'selected', cwd }, deps)
    const wait = await runAct(holder, { op: 'wait', expr: 'window.ready' }, deps)

    expect([until, wait]).toEqual([
      { ok: false, error: expect.stringContaining('allowEval') },
      { ok: false, error: expect.stringContaining('allowEval') },
    ])
    expect(conn.evaluate).not.toHaveBeenCalledWith(expect.stringContaining('window.ready'), expect.anything())
  })
})
