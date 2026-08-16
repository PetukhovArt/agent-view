import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock setup (hoisted so vi.mock factory can reference these) ───────────────

const { callOrder, mockDomResolve, mockDomBoxModel, mockCallFunctionOn, mockDispatchMouse, mockCaptureScreenshot, mockGetLayoutMetrics, mockHandleJsDialog, dialogHook, chooserHook, navigatedHook, mockSetIntercept, mockSetFileInputFiles, mockCDP } =
  vi.hoisted(() => {
    const callOrder: string[] = []

    // Captures the `Page.javascriptDialogOpening` listener so a test can fire it.
    const dialogHook: { fire?: (params: Record<string, unknown>) => void } = {}
    const mockHandleJsDialog = vi.fn().mockResolvedValue({})

    const chooserHook: { fire?: (params: Record<string, unknown>) => void } = {}
    const navigatedHook: { fire?: () => void } = {}
    const mockSetIntercept = vi.fn().mockResolvedValue({})
    const mockSetFileInputFiles = vi.fn().mockResolvedValue({})

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
        frameNavigated: vi.fn().mockImplementation((cb: () => void) => {
          navigatedHook.fire = cb
          return () => {}
        }),
        javascriptDialogOpening: vi.fn().mockImplementation((cb: (params: Record<string, unknown>) => void) => {
          dialogHook.fire = cb
          return () => {}
        }),
        handleJavaScriptDialog: mockHandleJsDialog,
        fileChooserOpened: vi.fn().mockImplementation((cb: (params: Record<string, unknown>) => void) => {
          chooserHook.fire = cb
          return () => {}
        }),
        setInterceptFileChooserDialog: mockSetIntercept,
      },
      DOM: {
        enable: vi.fn().mockResolvedValue({}),
        resolveNode: mockDomResolve,
        getBoxModel: mockDomBoxModel,
        focus: vi.fn().mockResolvedValue({}),
        getDocument: vi.fn().mockResolvedValue({ root: { backendNodeId: 1 } }),
        setFileInputFiles: mockSetFileInputFiles,
      },
      Input: { dispatchMouseEvent: mockDispatchMouse },
      Network: {
        enable: vi.fn().mockResolvedValue({}),
        getResponseBody: vi.fn().mockResolvedValue({ body: '', base64Encoded: false }),
        requestWillBeSent: vi.fn().mockReturnValue(() => {}),
        responseReceived: vi.fn().mockReturnValue(() => {}),
        loadingFinished: vi.fn().mockReturnValue(() => {}),
        loadingFailed: vi.fn().mockReturnValue(() => {}),
        webSocketCreated: vi.fn().mockReturnValue(() => {}),
        webSocketFrameSent: vi.fn().mockReturnValue(() => {}),
        webSocketFrameReceived: vi.fn().mockReturnValue(() => {}),
        webSocketFrameError: vi.fn().mockReturnValue(() => {}),
        webSocketClosed: vi.fn().mockReturnValue(() => {}),
        eventSourceMessageReceived: vi.fn().mockReturnValue(() => {}),
      },
      on: vi.fn(),
      close: vi.fn().mockResolvedValue({}),
    })

    return { callOrder, mockDomResolve, mockDomBoxModel, mockCallFunctionOn, mockDispatchMouse, mockCaptureScreenshot, mockGetLayoutMetrics, mockHandleJsDialog, dialogHook, chooserHook, navigatedHook, mockSetIntercept, mockSetFileInputFiles, mockCDP }
  })

vi.mock('chrome-remote-interface', () => ({ default: mockCDP }))

import { connectToPage, connectToRuntime, listTargets } from '../transport.js'
import { AxTreeCache } from '../ax-cache.js'
import { ConsoleLevel, JsDialogType, TargetType, type ConsoleMessage, type TargetInfo } from '../types.js'

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

  it('scale=0.5 fetches layout metrics and requests webp format', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    const result = await conn.captureScreenshot({ scale: 0.5 })
    expect(mockGetLayoutMetrics).toHaveBeenCalledOnce()
    expect(mockCaptureScreenshot).toHaveBeenCalledWith({
      format: 'webp',
      quality: 80,
      clip: { x: 0, y: 0, width: 1280, height: 720, scale: 0.5 },
    })
    expect(result.format).toBe('webp')
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

  it('falls back to jpeg when webp throws', async () => {
    mockCaptureScreenshot.mockRejectedValueOnce(new Error('Invalid format'))

    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    const result = await conn.captureScreenshot({ scale: 0.5 })

    expect(result.format).toBe('jpeg')
    expect(mockCaptureScreenshot).toHaveBeenCalledTimes(2)
    expect(mockCaptureScreenshot).toHaveBeenNthCalledWith(1, expect.objectContaining({ format: 'webp' }))
    expect(mockCaptureScreenshot).toHaveBeenNthCalledWith(2, expect.objectContaining({ format: 'jpeg' }))
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

  it('clicks: 2 dispatches press/release with clickCount sequence 1,1,2,2', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.clickByNodeId(42, { clicks: 2 })

    const mouseEvents = mockDispatchMouse.mock.calls.map((c) => ({ type: c[0].type, clickCount: c[0].clickCount }))
    expect(mouseEvents).toEqual([
      { type: 'mousePressed', clickCount: 1 },
      { type: 'mouseReleased', clickCount: 1 },
      { type: 'mousePressed', clickCount: 2 },
      { type: 'mouseReleased', clickCount: 2 },
    ])
  })

  it('clickAtPosition with clicks: 2 also produces 4 events', async () => {
    const conn = await connectToPage(9222, pageTarget, new AxTreeCache())
    await conn.clickAtPosition(50, 60, { clicks: 2 })

    expect(mockDispatchMouse).toHaveBeenCalledTimes(4)
    const allAtSamePos = mockDispatchMouse.mock.calls.every((c) => c[0].x === 50 && c[0].y === 60)
    expect(allAtSamePos).toBe(true)
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

// ── target enumeration is bounded ─────────────────────────────────────────────

describe('listTargets against a wedged CDP endpoint', () => {
  // Regression: a port that accepts TCP but never answers HTTP (app mid-restart)
  // used to leave /json/list pending forever, and with it every agent-view command.
  it('gives up instead of hanging when the port accepts TCP but never answers', async () => {
    const { createServer } = await import('node:net')
    const silent = createServer(() => { /* accept, never respond */ })
    await new Promise<void>(r => silent.listen(0, '127.0.0.1', () => r()))
    const port = (silent.address() as { port: number }).port

    vi.stubEnv('AGENT_VIEW_CDP_PROBE_TIMEOUT_MS', '300')
    try {
      const started = Date.now()
      await expect(listTargets(port)).resolves.toEqual([])
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      vi.unstubAllEnvs()
      silent.close()
    }
  })
})

describe('JS dialogs', () => {
  const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

  beforeEach(() => {
    mockHandleJsDialog.mockClear()
  })

  // Regression: connectToPage enables the Page domain, which makes Chromium hold
  // the renderer until the CDP client answers. With no answer an alert() froze
  // the session forever, and every later command timed out with no explanation.
  it('answers an opening dialog without being asked', async () => {
    await connectToPage(9222, pageTarget, new AxTreeCache())

    dialogHook.fire?.({ type: 'alert', message: 'boom', url: 'http://x' })
    await flush()

    expect(mockHandleJsDialog).toHaveBeenCalledWith({ accept: false })
  })

  it('applies the standing policy, prompt text included', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    session.setJsDialogPolicy({ accept: true, promptText: 'typed' })

    dialogHook.fire?.({ type: 'prompt', message: 'Name?', defaultPrompt: '', url: 'http://x' })
    await flush()

    expect(mockHandleJsDialog).toHaveBeenCalledWith({ accept: true, promptText: 'typed' })
    expect(session.getJsDialogPolicy()).toEqual({ accept: true, promptText: 'typed' })
  })

  // A subscriber must see the dialog even though it is answered at once —
  // otherwise the only observer of a modal would be racing the answer.
  it('reports the dialog to subscribers before answering it', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    const order: string[] = []
    mockHandleJsDialog.mockImplementationOnce(() => {
      order.push('answer')
      return Promise.resolve({})
    })
    session.onJsDialog(d => order.push(`subscriber:${d.type}:${d.message}`))

    dialogHook.fire?.({ type: 'confirm', message: 'Delete?', url: 'http://x' })
    await flush()

    expect(order).toEqual(['subscriber:confirm:Delete?', 'answer'])
  })

  it('keeps a log of what was answered and how', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())

    dialogHook.fire?.({ type: 'confirm', message: 'Delete?', url: 'http://x' })
    await flush()

    expect(session.recentJsDialogs()).toEqual([
      expect.objectContaining({
        type: JsDialogType.Confirm,
        message: 'Delete?',
        answer: { accept: false, promptText: undefined, automatic: true },
      }),
    ])
  })

  // The auto-answer is invisible in the UI, so it has to be visible in the feed —
  // otherwise a confirm() that silently returned false is unexplainable.
  it('records the auto-answer as a console warning', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    const messages: ConsoleMessage[] = []
    session.onConsole(m => messages.push(m))

    dialogHook.fire?.({ type: 'confirm', message: 'Delete?', url: 'http://x' })
    await flush()

    expect(messages).toEqual([
      expect.objectContaining({ level: ConsoleLevel.Warn, text: '[agent-view] confirm auto-dismissed: Delete?' }),
    ])
  })

  // A dialog opened before agent-view attached produced no opening event, so
  // there is nothing pending to match — the answer still has to go out.
  it('answers blind when nothing was tracked as pending', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())

    await session.answerJsDialog(true, 'manual')

    expect(mockHandleJsDialog).toHaveBeenCalledWith({ accept: true, promptText: 'manual' })
  })

  it('surfaces the CDP error when no dialog is showing', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    mockHandleJsDialog.mockRejectedValueOnce(new Error('No dialog is showing'))

    await expect(session.answerJsDialog(false)).rejects.toThrow('No dialog is showing')
  })
})

describe('file chooser interception', () => {
  const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

  beforeEach(() => {
    mockSetIntercept.mockClear()
    mockSetFileInputFiles.mockClear()
  })

  // Interception must stay off until asked for: turning it on by default would
  // suppress a chooser the user meant to see, and the app would look broken.
  it('does not intercept until something is armed', async () => {
    await connectToPage(9222, pageTarget, new AxTreeCache())

    expect(mockSetIntercept).not.toHaveBeenCalled()
  })

  it('turns interception on when armed with files', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())

    await session.armFileChooser({ kind: 'files', files: ['/tmp/a.png'] })

    expect(mockSetIntercept).toHaveBeenCalledWith({ enabled: true, cancel: false })
    expect(session.fileChooserArm()).toEqual({ kind: 'files', files: ['/tmp/a.png'] })
  })

  // Chromium's own cancel flag suppresses the chooser but does not deliver
  // `input.oncancel` to the page, so the outcome is driven from here instead.
  it('delivers a cancel event to the input the chooser came from', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    await session.armFileChooser({ kind: 'cancel' })
    expect(mockSetIntercept).toHaveBeenCalledWith({ enabled: true, cancel: false })
    mockCallFunctionOn.mockClear()

    chooserHook.fire?.({ mode: 'selectSingle', backendNodeId: 77 })
    await flush()

    expect(mockSetFileInputFiles).not.toHaveBeenCalled()
    expect(mockCallFunctionOn).toHaveBeenCalledWith(expect.objectContaining({
      functionDeclaration: expect.stringContaining("new Event('cancel')"),
    }))
    expect(session.recentFileChoosers()).toEqual([
      expect.objectContaining({ answer: 'cancel', matchedInput: true }),
    ])
  })

  it('fills the input the chooser came from, then disarms', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    await session.armFileChooser({ kind: 'files', files: ['/tmp/a.png'] })
    mockSetIntercept.mockClear()

    chooserHook.fire?.({ mode: 'selectSingle', backendNodeId: 77 })
    await flush()

    expect(mockSetFileInputFiles).toHaveBeenCalledWith({ backendNodeId: 77, files: ['/tmp/a.png'] })
    expect(session.fileChooserArm()).toBeNull()
    expect(mockSetIntercept).toHaveBeenCalledWith({ enabled: false })
    expect(session.recentFileChoosers()).toEqual([
      expect.objectContaining({ answer: 'files', matchedInput: true, files: ['/tmp/a.png'] }),
    ])
  })

  // `showOpenFilePicker` gives no backing node, so files cannot be injected.
  // Reporting success there would be a lie the caller cannot detect.
  it('reports a cancel when the chooser has no file input behind it', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    await session.armFileChooser({ kind: 'files', files: ['/tmp/a.png'] })

    chooserHook.fire?.({ mode: 'selectMultiple' })
    await flush()

    expect(mockSetFileInputFiles).not.toHaveBeenCalled()
    expect(session.recentFileChoosers()).toEqual([
      expect.objectContaining({ answer: 'cancel', matchedInput: false }),
    ])
  })

  it('disarms without leaving interception on', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    await session.armFileChooser({ kind: 'files', files: ['/tmp/a.png'] })

    await session.armFileChooser(null)

    expect(mockSetIntercept).toHaveBeenLastCalledWith({ enabled: false })
    expect(session.fileChooserArm()).toBeNull()
  })
})

describe('uploadBySelector', () => {
  beforeEach(() => {
    mockSetFileInputFiles.mockClear()
  })

  it('sets files on the node the selector resolves to', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    const client = await mockCDP.mock.results[0].value
    client.Runtime.evaluate.mockResolvedValueOnce({ result: { objectId: 'obj-7', type: 'object' } })

    await expect(session.uploadBySelector('#file', ['/tmp/a.png'])).resolves.toBe(true)

    expect(mockSetFileInputFiles).toHaveBeenCalledWith({ objectId: 'obj-7', files: ['/tmp/a.png'] })
  })

  it('reports no match instead of throwing when the selector finds nothing', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    const client = await mockCDP.mock.results[0].value
    client.Runtime.evaluate.mockResolvedValueOnce({ result: { type: 'object', subtype: 'null' } })

    await expect(session.uploadBySelector('#missing', ['/tmp/a.png'])).resolves.toBe(false)
    expect(mockSetFileInputFiles).not.toHaveBeenCalled()
  })
})

describe('modal answers stay consistent under failure and re-entry', () => {
  const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))
  const cancelDispatched = (): boolean =>
    mockCallFunctionOn.mock.calls.some(([p]) =>
      String((p as { functionDeclaration?: string }).functionDeclaration ?? '').includes("new Event('cancel')"))

  beforeEach(() => {
    mockSetIntercept.mockClear()
    mockSetFileInputFiles.mockClear()
    mockCallFunctionOn.mockClear()
    mockHandleJsDialog.mockClear()
  })

  // Regression: the chooser is already suppressed, so failing to attach files
  // without telling the page left it waiting for a user who never comes —
  // the exact hang the feature exists to prevent.
  it('cancels on the page when the files cannot be attached', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    await session.armFileChooser({ kind: 'files', files: ['/tmp/a.png'] })
    mockSetFileInputFiles.mockRejectedValueOnce(new Error('Node is not a file input element'))

    chooserHook.fire?.({ mode: 'selectSingle', backendNodeId: 77 })
    await flush()
    await flush()

    expect(cancelDispatched()).toBe(true)
    expect(session.recentFileChoosers()).toEqual([expect.objectContaining({ answer: 'cancel' })])
  })

  // Regression: answering is async, so a fresh arm could land mid-flight and be
  // silently killed by the old answer's disarm — status said "armed" while the
  // next chooser opened as a real OS window.
  it('does not disarm an arm that arrived while the previous answer was in flight', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    await session.armFileChooser({ kind: 'files', files: ['/tmp/a.png'] })

    chooserHook.fire?.({ mode: 'selectSingle', backendNodeId: 77 })
    await session.armFileChooser({ kind: 'files', files: ['/tmp/b.png'] })
    mockSetIntercept.mockClear()
    await flush()
    await flush()

    expect(mockSetIntercept).not.toHaveBeenCalledWith({ enabled: false })
    expect(session.fileChooserArm()).toEqual({ kind: 'files', files: ['/tmp/b.png'] })
  })

  // A new document means the click the arm was meant for never happened;
  // keeping it live would answer some later, unrelated chooser.
  it('forgets the arm when the page navigates', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    await session.armFileChooser({ kind: 'files', files: ['/tmp/a.png'] })
    mockSetIntercept.mockClear()

    navigatedHook.fire?.()
    await flush()

    expect(session.fileChooserArm()).toBeNull()
    expect(mockSetIntercept).toHaveBeenCalledWith({ enabled: false })
  })

  // Accepting beforeunload navigates away mid-run and loses everything under
  // inspection, so the standing answer — which exists for confirm() — must not
  // reach it.
  it('dismisses beforeunload even when the policy accepts', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    session.setJsDialogPolicy({ accept: true, promptText: 'typed' })

    dialogHook.fire?.({ type: 'beforeunload', message: '', url: 'http://x' })
    await flush()

    expect(mockHandleJsDialog).toHaveBeenCalledWith({ accept: false })
  })

  // The blind answer is the whole reason the manual command exists; leaving it
  // out of the log made that scenario invisible in `dialog status`.
  it('records a blind manual answer so it shows up in the log', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())

    await session.answerJsDialog(true, 'manual')

    expect(session.recentJsDialogs()).toEqual([
      expect.objectContaining({ answer: { accept: true, promptText: 'manual', automatic: false } }),
    ])
  })

  it('reports a malformed selector instead of treating the thrown error as the node', async () => {
    const session = await connectToPage(9222, pageTarget, new AxTreeCache())
    const client = await mockCDP.mock.results[0].value
    client.Runtime.evaluate.mockResolvedValueOnce({
      result: { objectId: 'err-1', type: 'object', subtype: 'error' },
      exceptionDetails: { text: 'Uncaught' },
    })

    await expect(session.uploadBySelector('div[', ['/tmp/a.png'])).rejects.toThrow('Invalid selector')
    expect(mockSetFileInputFiles).not.toHaveBeenCalled()
  })
})
