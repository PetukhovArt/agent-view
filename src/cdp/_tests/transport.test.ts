import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock setup (hoisted so vi.mock factory can reference these) ───────────────

const { callOrder, mockDomResolve, mockDomBoxModel, mockCallFunctionOn, mockDispatchMouse, mockCaptureScreenshot, mockGetLayoutMetrics, mockCDP } =
  vi.hoisted(() => {
    const callOrder: string[] = []

    const mockDomResolve = vi.fn().mockImplementation(() => {
      callOrder.push('DOM.resolveNode')
      return Promise.resolve({ object: { objectId: 'obj-42' } })
    })

    const mockDomBoxModel = vi.fn().mockImplementation(() => {
      callOrder.push('DOM.getBoxModel')
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

    const mockCaptureScreenshot = vi.fn().mockResolvedValue({ data: '' })
    const mockGetLayoutMetrics = vi.fn().mockResolvedValue({
      cssLayoutViewport: { clientWidth: 1280, clientHeight: 720 },
    })

    const mockCDP = vi.fn().mockResolvedValue({
      Runtime: {
        enable: vi.fn().mockResolvedValue({}),
        callFunctionOn: mockCallFunctionOn,
        evaluate: vi.fn().mockResolvedValue({ result: { value: undefined } }),
        consoleAPICalled: vi.fn().mockReturnValue(() => {}),
      },
      Log: {
        enable: vi.fn().mockResolvedValue({}),
        entryAdded: vi.fn().mockReturnValue(() => {}),
      },
      Accessibility: {
        enable: vi.fn().mockResolvedValue({}),
        getFullAXTree: vi.fn().mockResolvedValue({ nodes: [] }),
        queryAXTree: vi.fn().mockResolvedValue({ nodes: [] }),
      },
      Page: {
        enable: vi.fn().mockResolvedValue({}),
        captureScreenshot: mockCaptureScreenshot,
        getLayoutMetrics: mockGetLayoutMetrics,
        frameNavigated: vi.fn(),
      },
      DOM: {
        enable: vi.fn().mockResolvedValue({}),
        resolveNode: mockDomResolve,
        getBoxModel: mockDomBoxModel,
        focus: vi.fn().mockResolvedValue({}),
        getDocument: vi.fn().mockResolvedValue({ root: { backendNodeId: 1 } }),
      },
      Input: { dispatchMouseEvent: mockDispatchMouse },
      close: vi.fn().mockResolvedValue({}),
    })

    return { callOrder, mockDomResolve, mockDomBoxModel, mockCallFunctionOn, mockDispatchMouse, mockCaptureScreenshot, mockGetLayoutMetrics, mockCDP }
  })

vi.mock('chrome-remote-interface', () => ({ default: mockCDP }))

import { connectToPage, connectToRuntime } from '../transport.js'
import { AxTreeCache } from '../ax-cache.js'
import { TargetType, type TargetInfo } from '../types.js'

const pageTarget: TargetInfo = { id: 'target-1', type: TargetType.Page, title: 'Test', url: 'http://x' }
const workerTarget: TargetInfo = { id: 'worker-1', type: TargetType.SharedWorker, title: 'sw.js', url: 'http://x/sw' }

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('captureScreenshot', () => {
  beforeEach(() => {
    mockCaptureScreenshot.mockClear()
    mockGetLayoutMetrics.mockClear()
  })

  it('default (no scale) calls captureScreenshot with png format, no clip', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.captureScreenshot()
    expect(mockCaptureScreenshot).toHaveBeenCalledWith({ format: 'png' })
    expect(mockGetLayoutMetrics).not.toHaveBeenCalled()
  })

  it('scale=1 behaves same as no scale', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.captureScreenshot({ scale: 1 })
    expect(mockCaptureScreenshot).toHaveBeenCalledWith({ format: 'png' })
    expect(mockGetLayoutMetrics).not.toHaveBeenCalled()
  })

  it('scale=0.5 fetches layout metrics and passes clip with scale', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.captureScreenshot({ scale: 0.5 })
    expect(mockGetLayoutMetrics).toHaveBeenCalledOnce()
    expect(mockCaptureScreenshot).toHaveBeenCalledWith({
      format: 'jpeg',
      quality: 80,
      clip: { x: 0, y: 0, width: 1280, height: 720, scale: 0.5 },
    })
  })

  it('scale=0.25 uses viewport dimensions from getLayoutMetrics', async () => {
    mockGetLayoutMetrics.mockResolvedValueOnce({
      cssLayoutViewport: { clientWidth: 1920, clientHeight: 1080 },
    })

    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.captureScreenshot({ scale: 0.25 })

    expect(mockCaptureScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        clip: expect.objectContaining({ width: 1920, height: 1080, scale: 0.25 }),
      }),
    )
  })
})

describe('clickByNodeId', () => {
  beforeEach(() => {
    callOrder.length = 0
    mockDomResolve.mockClear()
    mockDomBoxModel.mockClear()
    mockCallFunctionOn.mockClear()
    mockDispatchMouse.mockClear()
  })

  it('scrolls element into view before reading the box model (so coords are post-scroll)', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.clickByNodeId(42)

    const resolveIdx = callOrder.indexOf('DOM.resolveNode')
    const boxIdx = callOrder.indexOf('DOM.getBoxModel')
    const scrollIdx = callOrder.indexOf('Runtime.callFunctionOn')

    expect(resolveIdx).toBeGreaterThanOrEqual(0)
    expect(boxIdx).toBeGreaterThanOrEqual(0)
    expect(scrollIdx).toBeGreaterThan(resolveIdx)
    expect(boxIdx).toBeGreaterThan(scrollIdx)
  })

  it('sends mousePressed before mouseReleased', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.clickByNodeId(42)

    const pressIdx = callOrder.indexOf('Input.mousePressed')
    const releaseIdx = callOrder.indexOf('Input.mouseReleased')

    expect(pressIdx).toBeGreaterThanOrEqual(0)
    expect(releaseIdx).toBeGreaterThanOrEqual(0)
    expect(pressIdx).toBeLessThan(releaseIdx)
  })

  it('dispatches both mousePressed and mouseReleased events', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.clickByNodeId(42)

    const mouseCalls = mockDispatchMouse.mock.calls.map((c) => c[0].type)
    expect(mouseCalls).toContain('mousePressed')
    expect(mouseCalls).toContain('mouseReleased')
    expect(mockDispatchMouse).toHaveBeenCalledTimes(2)
  })

  it('calculates center coordinates from box model content array', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.clickByNodeId(42)

    const pressCall = mockDispatchMouse.mock.calls.find((c) => c[0].type === 'mousePressed')
    expect(pressCall?.[0].x).toBe(20)
    expect(pressCall?.[0].y).toBe(30)
  })

  it('passes backendNodeId to both resolveNode and getBoxModel', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.clickByNodeId(99)

    expect(mockDomResolve).toHaveBeenCalledWith({ backendNodeId: 99 })
    expect(mockDomBoxModel).toHaveBeenCalledWith({ backendNodeId: 99 })
  })

  it('uses objectId from resolveNode for scroll callFunctionOn', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.clickByNodeId(42)

    expect(mockCallFunctionOn).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: 'obj-42' }),
    )
  })
})

describe('dragBetweenPositions', () => {
  beforeEach(() => {
    callOrder.length = 0
    mockDispatchMouse.mockClear()
  })

  it('emits press → moves → release in order', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.dragBetweenPositions({ x: 0, y: 0 }, { x: 100, y: 50 }, { steps: 4 })

    const types = mockDispatchMouse.mock.calls.map((c) => c[0].type)
    expect(types[0]).toBe('mousePressed')
    expect(types[types.length - 1]).toBe('mouseReleased')
    // 4 intermediate + 1 final move = 5 mouseMoved events
    const moves = types.filter((t) => t === 'mouseMoved')
    expect(moves).toHaveLength(5)
  })

  it('default steps = 10 produces 11 mouseMoved events (10 interior + 1 final)', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.dragBetweenPositions({ x: 0, y: 0 }, { x: 100, y: 0 })

    const moves = mockDispatchMouse.mock.calls.filter((c) => c[0].type === 'mouseMoved')
    expect(moves).toHaveLength(11)
  })

  it('final mouseReleased lands exactly at the destination', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.dragBetweenPositions({ x: 10, y: 20 }, { x: 200, y: 300 }, { steps: 3 })

    const release = mockDispatchMouse.mock.calls.find((c) => c[0].type === 'mouseReleased')
    expect(release?.[0].x).toBe(200)
    expect(release?.[0].y).toBe(300)
  })

  it('intermediate moves interpolate linearly between from and to', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.dragBetweenPositions({ x: 0, y: 0 }, { x: 100, y: 100 }, { steps: 3 })

    const moves = mockDispatchMouse.mock.calls
      .filter((c) => c[0].type === 'mouseMoved')
      .map((c) => ({ x: c[0].x, y: c[0].y }))

    // steps=3 → t = 1/4, 2/4, 3/4, then final at 1
    expect(moves[0]).toEqual({ x: 25, y: 25 })
    expect(moves[1]).toEqual({ x: 50, y: 50 })
    expect(moves[2]).toEqual({ x: 75, y: 75 })
    expect(moves[3]).toEqual({ x: 100, y: 100 })
  })

  it('passes button option through to all dispatched events', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.dragBetweenPositions({ x: 0, y: 0 }, { x: 50, y: 50 }, { steps: 2, button: 'right' as never })

    const buttons = new Set(mockDispatchMouse.mock.calls.map((c) => c[0].button))
    expect(buttons).toEqual(new Set(['right']))
  })
})

describe('getBoxCenter', () => {
  beforeEach(() => {
    callOrder.length = 0
    mockDomResolve.mockClear()
    mockDomBoxModel.mockClear()
    mockCallFunctionOn.mockClear()
  })

  it('returns center coordinates from box model', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    const point = await conn.getBoxCenter(42)
    // box content [10,20, 30,20, 30,40, 10,40] → center (20, 30)
    expect(point).toEqual({ x: 20, y: 30 })
  })

  it('scrollIntoView=false skips the scroll callFunctionOn', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.getBoxCenter(42, { scrollIntoView: false })
    expect(mockCallFunctionOn).not.toHaveBeenCalled()
  })

  it('scrollIntoView default = true triggers callFunctionOn', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.getBoxCenter(42)
    expect(mockCallFunctionOn).toHaveBeenCalledOnce()
  })
})

// ── Session split: page vs runtime factories ──────────────────────────────────

describe('connectToRuntime', () => {
  it('refuses to enable Page/DOM/Accessibility on a worker target (only Runtime+Log)', async () => {
    const session = await connectToRuntime(9222, workerTarget)
    // Smoke: session has evaluate + onConsole + close
    expect(typeof session.evaluate).toBe('function')
    expect(typeof session.onConsole).toBe('function')
    expect(typeof session.close).toBe('function')
    expect(session.target.type).toBe(TargetType.SharedWorker)
  })
})

describe('connectToPage', () => {
  it('rejects non-page/iframe targets', async () => {
    await expect(connectToPage(9222, workerTarget, new AxTreeCache())).rejects.toThrow(/requires a page\/iframe target/)
  })
})

describe('evaluate', () => {
  async function getEvalMock(): Promise<ReturnType<typeof vi.fn>> {
    const client = await mockCDP.mock.results[mockCDP.mock.results.length - 1].value as { Runtime: { evaluate: ReturnType<typeof vi.fn> } }
    return client.Runtime.evaluate
  }

  it('returns the unwrapped value (returnByValue: true by default)', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    const evalMock = await getEvalMock()
    evalMock.mockResolvedValueOnce({ result: { value: 42 } })
    const v = await session.evaluate('1 + 41')
    expect(v).toBe(42)
  })

  it('throws EvaluationError when CDP returns exceptionDetails', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    const evalMock = await getEvalMock()
    evalMock.mockResolvedValueOnce({
      result: {},
      exceptionDetails: { exception: { description: 'ReferenceError: x is not defined' } },
    })
    await expect(session.evaluate('x')).rejects.toThrow(/ReferenceError/)
  })
})
