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
    await writeScript({ store, name: 'open' }, { until: { testid: 'done' }, steps: [step] })
    const conn = fakeConn()
    const deps = { conn: conn as unknown as PageSession, invalidateAxCache: () => {}, reconnect: async () => deps.conn, isEvalAllowed: false }

    const result = await replay({ store, name: 'open' }, deps)

    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(conn.clickByNodeId).toHaveBeenCalledExactlyOnceWith(NODE_ID, opts)
  })

  it('acts again on a control found before its box is drawn (a virtual list row), instead of STALE', async () => {
    const store = mkdtempSync(join(tmpdir(), 'av-replay-'))
    await writeScript({ store, name: 'open' }, { until: { testid: 'done' }, steps: [{ op: 'click', target: { role: 'button', name: 'Сцена' }, isPassword: false }] })
    const conn = fakeConn()
    conn.clickByNodeId.mockRejectedValueOnce(new Error('Could not compute box model.'))
    const deps = { conn: conn as unknown as PageSession, invalidateAxCache: () => {}, reconnect: async () => deps.conn, isEvalAllowed: false }

    const result = await replay({ store, name: 'open' }, deps)

    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(conn.clickByNodeId).toHaveBeenCalledTimes(2)
  })

  const saveWaitThenClick = async () => {
    const store = mkdtempSync(join(tmpdir(), 'av-replay-'))
    const steps = [{ op: 'wait' as const, expr: 'window.loaded' }, { op: 'click' as const, target: { role: 'button', name: 'Сцена' }, isPassword: false }]
    await writeScript({ store, name: 'open' }, { until: { testid: 'done' }, steps })
    const calls: string[] = []
    const conn = { ...fakeConn(), evaluate: vi.fn(async () => (calls.push('evaluate'), calls.length > 1)) }
    conn.clickByNodeId.mockImplementation(async () => { calls.push('click') })
    return { store, conn, calls }
  }

  it('waits on a recorded expression until it holds before the next step', async () => {
    const { store, conn, calls } = await saveWaitThenClick()
    const deps = { conn: conn as unknown as PageSession, invalidateAxCache: () => {}, reconnect: async () => deps.conn, isEvalAllowed: true }

    const result = await replay({ store, name: 'open' }, deps)

    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(calls).toEqual(['evaluate', 'evaluate', 'click'])
  })

  it('refuses a script that evaluates JS while allowEval is off, before any step', async () => {
    const { store, conn } = await saveWaitThenClick()
    const deps = { conn: conn as unknown as PageSession, invalidateAxCache: () => {}, reconnect: async () => deps.conn, isEvalAllowed: false }

    const result = await replay({ store, name: 'open' }, deps)

    expect(result).toMatchObject({ ok: false })
    expect(conn.evaluate).not.toHaveBeenCalled()
    expect(conn.clickByNodeId).not.toHaveBeenCalled()
  })

  const saveRowClick = async () => {
    const store = mkdtempSync(join(tmpdir(), 'av-replay-'))
    const step = { op: 'click' as const, target: { testid: 'row-${ROW}', role: 'button', name: '' }, isPassword: false }
    await writeScript({ store, name: 'row' }, { until: { testid: 'row-selected' }, steps: [step] })
    await writeScript({ store, name: 'row-then' }, { until: { testid: 'done' }, steps: [], after: 'row' })
    const conn = fakeConn({ 'data-testid': 'row-library/Насосы' })
    // The prerequisite's until shows only once its row was clicked, so replay runs it.
    conn.queryVisible = async (css: string) =>
      css.includes('row-selected') && !conn.clickByNodeId.mock.calls.length ? { backendDOMNodeId: null, count: 0 } : { backendDOMNodeId: 1, count: 1 }
    const deps = { conn: conn as unknown as PageSession, invalidateAxCache: () => {}, reconnect: async () => deps.conn, isEvalAllowed: false }
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
    await writeScript({ store, name: 'menu-open' }, { until: { testid: 'menu' }, steps: [click] })
    await writeScript({ store, name: 'form-open' }, { until: { testid: 'form' }, steps: [click], after: 'menu-open' })
    await writeScript({ store, name: 'form-fill' }, { until: { testid: 'done' }, steps: [], after: 'form-open' })
    const conn = fakeConn()
    conn.queryVisible = async (css: string) => (css.includes('menu') ? { backendDOMNodeId: null, count: 0 } : { backendDOMNodeId: 1, count: 1 })
    const deps = { conn: conn as unknown as PageSession, invalidateAxCache: () => {}, reconnect: async () => deps.conn, isEvalAllowed: false }

    const result = await replay({ store, name: 'form-fill' }, deps)

    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(conn.clickByNodeId).not.toHaveBeenCalled()
  })

  it('runs a use case from its first step not reached, though a later step\'s until already holds', async () => {
    const store = mkdtempSync(join(tmpdir(), 'av-replay-'))
    const click = { op: 'click' as const, target: { role: 'button', name: 'Сцена' }, isPassword: false }
    await writeScript({ store, name: 'menu-open' }, { until: { testid: 'menu' }, steps: [click] })
    // «Close the dialog»: its until (no dialog) holds before the use case has opened one.
    await writeScript({ store, name: 'dialog-close' }, { until: { selector: 'body:not(:has(.dialog))' }, steps: [click] })
    await writeScript({ store, name: 'flow-use-case' }, { until: { testid: 'done' }, use: [{ step: 'menu-open' }, { step: 'dialog-close' }] })
    const conn = fakeConn()
    conn.queryVisible = async (css: string) =>
      css.includes('menu') && !conn.clickByNodeId.mock.calls.length ? { backendDOMNodeId: null, count: 0 } : { backendDOMNodeId: 1, count: 1 }
    const deps = { conn: conn as unknown as PageSession, invalidateAxCache: () => {}, reconnect: async () => deps.conn, isEvalAllowed: false }

    const result = await replay({ store, name: 'flow-use-case' }, deps)

    expect(result).toMatchObject({ ok: true, exitCode: 0 })
    expect(conn.clickByNodeId).toHaveBeenCalledTimes(2)
  })
})
