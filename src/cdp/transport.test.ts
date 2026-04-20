import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock setup (hoisted so vi.mock factory can reference these) ───────────────

const { callOrder, mockDomResolve, mockDomBoxModel, mockCallFunctionOn, mockDispatchMouse, mockCDP } =
  vi.hoisted(() => {
    const callOrder: string[] = []

    const mockDomResolve = vi.fn().mockImplementation(() => {
      callOrder.push('DOM.resolveNode')
      return Promise.resolve({ object: { objectId: 'obj-42' } })
    })

    const mockDomBoxModel = vi.fn().mockImplementation(() => {
      callOrder.push('DOM.getBoxModel')
      // Corners: tl(10,20), tr(30,20), br(30,40), bl(10,40) → center (20,30)
      return Promise.resolve({ model: { content: [10, 20, 30, 20, 30, 40, 10, 40] } })
    })

    const mockCallFunctionOn = vi.fn().mockImplementation(() => {
      callOrder.push('Runtime.callFunctionOn')
      return Promise.resolve({})
    })

    const mockDispatchMouse = vi.fn().mockImplementation(({ type }: { type: string }) => {
      callOrder.push(`Input.${type}`)
      return Promise.resolve({})
    })

    const mockCDP = vi.fn().mockResolvedValue({
      Runtime: { callFunctionOn: mockCallFunctionOn, evaluate: vi.fn().mockResolvedValue({ result: {} }) },
      Accessibility: {
        enable: vi.fn().mockResolvedValue({}),
        getFullAXTree: vi.fn().mockResolvedValue({ nodes: [] }),
      },
      Page: { enable: vi.fn().mockResolvedValue({}), captureScreenshot: vi.fn().mockResolvedValue({ data: '' }), frameNavigated: vi.fn() },
      DOM: {
        enable: vi.fn().mockResolvedValue({}),
        resolveNode: mockDomResolve,
        getBoxModel: mockDomBoxModel,
        focus: vi.fn().mockResolvedValue({}),
      },
      Input: { dispatchMouseEvent: mockDispatchMouse },
      close: vi.fn().mockResolvedValue({}),
    })

    return { callOrder, mockDomResolve, mockDomBoxModel, mockCallFunctionOn, mockDispatchMouse, mockCDP }
  })

vi.mock('chrome-remote-interface', () => ({ default: mockCDP }))

// Import after mock is registered
import { connectToTarget } from './transport.js'
import { AxTreeCache } from './ax-cache.js'

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('clickByNodeId', () => {
  beforeEach(() => {
    callOrder.length = 0
    mockDomResolve.mockClear()
    mockDomBoxModel.mockClear()
    mockCallFunctionOn.mockClear()
    mockDispatchMouse.mockClear()
  })

  it('calls resolveNode and getBoxModel before callFunctionOn (parallel batch)', async () => {
    const conn = await connectToTarget(9222, 'target-1', new AxTreeCache())
    await conn.clickByNodeId(42)

    const resolveIdx = callOrder.indexOf('DOM.resolveNode')
    const boxIdx = callOrder.indexOf('DOM.getBoxModel')
    const scrollIdx = callOrder.indexOf('Runtime.callFunctionOn')

    // Both resolveNode and getBoxModel must complete before callFunctionOn
    expect(resolveIdx).toBeGreaterThanOrEqual(0)
    expect(boxIdx).toBeGreaterThanOrEqual(0)
    expect(scrollIdx).toBeGreaterThan(resolveIdx)
    expect(scrollIdx).toBeGreaterThan(boxIdx)
  })

  it('sends mousePressed before mouseReleased', async () => {
    const conn = await connectToTarget(9222, 'target-1', new AxTreeCache())
    await conn.clickByNodeId(42)

    const pressIdx = callOrder.indexOf('Input.mousePressed')
    const releaseIdx = callOrder.indexOf('Input.mouseReleased')

    expect(pressIdx).toBeGreaterThanOrEqual(0)
    expect(releaseIdx).toBeGreaterThanOrEqual(0)
    expect(pressIdx).toBeLessThan(releaseIdx)
  })

  it('dispatches both mousePressed and mouseReleased events', async () => {
    const conn = await connectToTarget(9222, 'target-1', new AxTreeCache())
    await conn.clickByNodeId(42)

    const mouseCalls = mockDispatchMouse.mock.calls.map((c) => c[0].type)
    expect(mouseCalls).toContain('mousePressed')
    expect(mouseCalls).toContain('mouseReleased')
    expect(mockDispatchMouse).toHaveBeenCalledTimes(2)
  })

  it('calculates center coordinates from box model content array', async () => {
    // content = [x1,y1, x2,y2, x3,y3, x4,y4] (tl, tr, br, bl)
    // center = avg(x1,x2,x3,x4), avg(y1,y2,y3,y4)
    // [10,20, 30,20, 30,40, 10,40] → cx=20, cy=30
    const conn = await connectToTarget(9222, 'target-1', new AxTreeCache())
    await conn.clickByNodeId(42)

    const pressCall = mockDispatchMouse.mock.calls.find((c) => c[0].type === 'mousePressed')
    expect(pressCall?.[0].x).toBe(20)
    expect(pressCall?.[0].y).toBe(30)
  })

  it('passes backendNodeId to both resolveNode and getBoxModel', async () => {
    const conn = await connectToTarget(9222, 'target-1', new AxTreeCache())
    await conn.clickByNodeId(99)

    expect(mockDomResolve).toHaveBeenCalledWith({ backendNodeId: 99 })
    expect(mockDomBoxModel).toHaveBeenCalledWith({ backendNodeId: 99 })
  })

  it('uses objectId from resolveNode for scroll callFunctionOn', async () => {
    const conn = await connectToTarget(9222, 'target-1', new AxTreeCache())
    await conn.clickByNodeId(42)

    expect(mockCallFunctionOn).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: 'obj-42' }),
    )
  })
})
