import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MouseButton, type PageSession } from '../cdp/types.js'
import { writeScript, type ClickOp } from './act-script.js'
import { replay } from './act-replay.js'

const NODE_ID = 7

/** A window with one on-screen, uncovered button; the until element is always visible. */
const fakeConn = (attributes: Record<string, string> = {}) => ({
  getAccessibilityTree: async () => [{ nodeId: 'ax7', role: { value: 'button' }, name: { value: 'Сцена' }, backendDOMNodeId: NODE_ID }],
  getLayoutSnapshot: async () => ({
    viewport: { width: 800, height: 600 },
    nodes: new Map([[NODE_ID, { rect: { x: 10, y: 10, width: 100, height: 20 }, tag: 'button', attributes, cursor: 'pointer' }]]),
  }),
  hitTest: async () => null,
  queryVisible: async (_css: string): Promise<{ backendDOMNodeId: number | null; count: number }> => ({ backendDOMNodeId: 1, count: 1 }),
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

  const saveRowClick = async () => {
    const store = mkdtempSync(join(tmpdir(), 'av-replay-'))
    const step = { op: 'click' as const, target: { testid: 'row-${ROW}', role: 'button', name: '' }, isPassword: false }
    await writeScript(store, 'row', { until: { testid: 'row-selected' }, steps: [step] })
    await writeScript(store, 'row-then', { until: { testid: 'done' }, steps: [], after: 'row' })
    const conn = fakeConn({ 'data-testid': 'row-library/Насосы' })
    // The prerequisite's until shows only once its row was clicked, so replay runs it.
    conn.queryVisible = async (css: string) =>
      css.includes('row-selected') && !conn.clickByNodeId.mock.calls.length ? { backendDOMNodeId: null, count: 0 } : { backendDOMNodeId: 1, count: 1 }
    const deps = { conn: conn as unknown as PageSession, invalidateAxCache: () => {}, reconnect: async () => deps.conn }
    return { store, conn, deps }
  }

  it('fills a ${NAME} target from params, through the after chain', async () => {
    const { store, conn, deps } = await saveRowClick()

    const result = await replay({ store, name: 'row-then', params: { ROW: 'library/Насосы' } }, deps)

    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(conn.clickByNodeId).toHaveBeenCalledOnce()
  })

  it('refuses a run with a parameter unset, naming it and the script, before any click', async () => {
    const { store, conn, deps } = await saveRowClick()

    const result = await replay({ store, name: 'row-then', params: {} }, deps)

    expect(result).toEqual({ ok: false, error: '"row" needs ROW — set as env vars' })
    expect(conn.clickByNodeId).not.toHaveBeenCalled()
  })

  it('skips every prerequisite before the nearest one already reached, though its own until is gone', async () => {
    const store = mkdtempSync(join(tmpdir(), 'av-replay-'))
    const click = { op: 'click' as const, target: { role: 'button', name: 'Сцена' }, isPassword: false }
    // The menu the next prerequisite's item closed: running menu-open again would wait for it in vain.
    await writeScript(store, 'menu-open', { until: { testid: 'menu' }, steps: [click] })
    await writeScript(store, 'form-open', { until: { testid: 'form' }, steps: [click], after: 'menu-open' })
    await writeScript(store, 'form-fill', { until: { testid: 'done' }, steps: [], after: 'form-open' })
    const conn = fakeConn()
    conn.queryVisible = async (css: string) => (css.includes('menu') ? { backendDOMNodeId: null, count: 0 } : { backendDOMNodeId: 1, count: 1 })
    const deps = { conn: conn as unknown as PageSession, invalidateAxCache: () => {}, reconnect: async () => deps.conn }

    const result = await replay({ store, name: 'form-fill' }, deps)

    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(conn.clickByNodeId).not.toHaveBeenCalled()
  })
})
