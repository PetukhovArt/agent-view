import { createServer, type Server, type Socket } from 'node:net'
import { writeFile, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { getAdapter } from '../adapters/registry.js'
import { formatAccessibilityTree } from '../inspectors/dom/index.js'
import { getSceneGraph, getRawScene, diffScenes, type SceneNode } from '../inspectors/scene/index.js'
import { RefStore } from './ref-store.js'
import { launch, isRunning } from './launcher.js'
import { readConfig } from '../config/manager.js'
import { RuntimeType, WebGLEngine, type ServerRequest, type ServerResponse, type WindowInfo } from '../types.js'
import {
  TargetType,
  ConsoleLevel,
  EvaluationError,
  MouseButton,
  type PageSession,
  type RuntimeSession,
  type TargetInfo,
  type Point,
  type DragOpts,
} from '../cdp/types.js'
import { listSupportedTargets, connectToRuntime } from '../cdp/transport.js'
import { ConsoleStream, type StampedConsoleMessage } from '../cdp/_tests/console-stream.js'
import { AxTreeCache } from '../cdp/ax-cache.js'
import { WatchSession } from './watch-session.js'
import { StopReason, WATCH_MIN_INTERVAL_MS, type WatchFrame } from '../inspectors/watch/index.js'

const SERVER_PORT = 47922
const VALID_RUNTIMES = new Set<RuntimeType>(Object.values(RuntimeType))
const VALID_ENGINES = new Set<WebGLEngine>(Object.values(WebGLEngine))
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DELIMITER = '\n'
const MAX_BUFFER_SIZE = 1_048_576 // 1 MB
const TOKEN_DIR = join(homedir(), '.agent-view')
const TOKEN_PATH = join(TOKEN_DIR, 'token')
const EVAL_OUTPUT_CAP = 64 * 1024
const DEFAULT_CONSOLE_TARGETS: ReadonlyArray<TargetType> = [TargetType.Page, TargetType.SharedWorker, TargetType.ServiceWorker]

const RUNTIME_ONLY_TARGETS = new Set<TargetType>([
  TargetType.SharedWorker,
  TargetType.ServiceWorker,
  TargetType.Worker,
])

function argStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' ? v : undefined
}

function argNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  return typeof v === 'number' ? v : undefined
}

function argBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]
  return typeof v === 'boolean' ? v : undefined
}

function argStrArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key]
  if (!Array.isArray(v)) return undefined
  return v.filter((x): x is string => typeof x === 'string')
}

const ARIA_ROLES = new Set([
  'button', 'link', 'menuitem', 'tab', 'checkbox', 'radio',
  'textbox', 'searchbox', 'combobox', 'spinbutton', 'textarea',
  'listitem', 'option', 'treeitem', 'cell', 'row', 'heading',
])

type ParsedFilter =
  | { kind: 'simple'; name: string; role?: string }
  | { kind: 'heuristic'; raw: string }

export function resolveDepth(filter: string | undefined, explicit: number | undefined): number | undefined {
  if (explicit !== undefined) return explicit
  if (filter !== undefined) return undefined  // unlimited depth when filtering
  return 4  // default snapshot depth
}

export async function textContentFallback(conn: PageSession, filter: string): Promise<string> {
  const safeFilter = JSON.stringify(filter)
  const js = `(() => {
    const q = ${safeFilter};
    const results = [];
    for (const el of document.querySelectorAll('body *')) {
      if (results.length >= 5) break;
      const directText = Array.from(el.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE)
        .map(n => n.textContent.trim())
        .join(' ');
      if (directText.toLowerCase().includes(q.toLowerCase()) && el.offsetParent !== null) {
        const id = el.id ? '#' + el.id : '';
        const cls = el.className && typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\\s+/)[0] : '';
        results.push(el.tagName.toLowerCase() + id + cls);
      }
    }
    return results.length ? results.join(', ') : null;
  })()`

  const result = await conn.evaluate(js)
  if (!result || typeof result !== 'string') {
    return `(no text-match for "${filter}")`
  }

  return result.split(', ')
    .map(loc => `[text-match] "${filter}" found in ${loc} (no accessible role in AX tree)`)
    .join('\n')
}

export function parseFilter(filter: string): ParsedFilter {
  const colonIdx = filter.indexOf(':')
  if (colonIdx > 0) {
    const role = filter.slice(0, colonIdx).trim().toLowerCase()
    const name = filter.slice(colonIdx + 1).trim()
    if (name && ARIA_ROLES.has(role)) {
      return { kind: 'simple', name, role }
    }
  }
  if (filter.startsWith('~') || /[.*+?^${}()|[\]\\]/.test(filter)) {
    return { kind: 'heuristic', raw: filter }
  }
  return { kind: 'simple', name: filter }
}

type CachedSession =
  | { kind: 'page'; session: PageSession }
  | { kind: 'runtime'; session: RuntimeSession }

export class AgentViewServer {
  private server: Server | null = null
  private connections = new Map<string, CachedSession>()
  private refStore = new RefStore()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private sceneCache = new Map<string, SceneNode>()
  private axTreeCache = new AxTreeCache()
  private consoleStream = new ConsoleStream()
  private token = ''
  private activeWatches = new Set<WatchSession>()

  private readonly handlers = {
    discover: (req: ServerRequest) => this.handleDiscover(req),
    launch: (req: ServerRequest) => this.handleLaunch(req),
    dom: (req: ServerRequest) => this.handleDom(req),
    click: (req: ServerRequest) => this.handleClick(req),
    drag: (req: ServerRequest) => this.handleDrag(req),
    fill: (req: ServerRequest) => this.handleFill(req),
    wait: (req: ServerRequest) => this.handleWait(req),
    screenshot: (req: ServerRequest) => this.handleScreenshot(req),
    scene: (req: ServerRequest) => this.handleScene(req),
    snap: (req: ServerRequest) => this.handleSnap(req),
    targets: (req: ServerRequest) => this.handleTargets(req),
    eval: (req: ServerRequest) => this.handleEval(req),
    console: (req: ServerRequest) => this.handleConsole(req),
    stop: () => this.handleStop(),
  } as const satisfies Record<string, (req: ServerRequest) => Promise<ServerResponse>>

  private readonly streamingCommands: ReadonlySet<string> = new Set(['watch'])
  private readonly validCommands: ReadonlySet<string> = new Set([...Object.keys(this.handlers), ...this.streamingCommands])

  async start(): Promise<void> {
    mkdirSync(TOKEN_DIR, { recursive: true })
    this.token = randomBytes(32).toString('hex')
    await writeFile(TOKEN_PATH, this.token, { mode: 0o600 })

    return new Promise((resolve, reject) => {
      this.server = createServer((socket: Socket) => this.handleSocket(socket))
      this.server.on('error', reject)
      this.server.listen(SERVER_PORT, '127.0.0.1', () => {
        this.resetIdleTimer()
        resolve()
      })
    })
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.activeWatches.size > 0) {
      // Pause idle shutdown while streaming handlers are alive.
      this.idleTimer = null
      return
    }
    this.idleTimer = setTimeout(() => this.shutdown(), IDLE_TIMEOUT_MS)
  }

  private handleSocket(socket: Socket): void {
    this.resetIdleTimer()
    let buffer = ''

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      if (buffer.length > MAX_BUFFER_SIZE) {
        socket.destroy(new Error('Request too large'))
        return
      }
      const delimIndex = buffer.indexOf(DELIMITER)
      if (delimIndex !== -1) {
        const message = buffer.slice(0, delimIndex)
        buffer = ''
        this.processRequest(message, socket)
      }
    })
  }

  private async processRequest(data: string, socket: Socket): Promise<void> {
    try {
      const request = JSON.parse(data) as ServerRequest
      if (request.token !== this.token) {
        socket.end(JSON.stringify({ ok: false, error: 'Unauthorized' } satisfies ServerResponse) + DELIMITER)
        return
      }
      if (
        typeof request.command !== 'string' || !this.validCommands.has(request.command) ||
        (request.command !== 'stop' && (
          !VALID_RUNTIMES.has(request.runtime) ||
          typeof request.port !== 'number' || request.port < 1 || request.port > 65535
        ))
      ) {
        socket.end(JSON.stringify({ ok: false, error: 'Invalid request' } satisfies ServerResponse) + DELIMITER)
        return
      }
      if (request.engine !== undefined && !VALID_ENGINES.has(request.engine)) {
        socket.end(JSON.stringify({ ok: false, error: 'Invalid engine' } satisfies ServerResponse) + DELIMITER)
        return
      }
      if (!request.args || typeof request.args !== 'object' || Array.isArray(request.args)) {
        socket.end(JSON.stringify({ ok: false, error: 'Invalid args' } satisfies ServerResponse) + DELIMITER)
        return
      }
      if (this.streamingCommands.has(request.command)) {
        await this.handleWatchStreaming(request, socket)
        return
      }
      const response = await this.handleCommand(request)
      socket.end(JSON.stringify(response) + DELIMITER)
    } catch (err) {
      const response: ServerResponse = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
      socket.end(JSON.stringify(response) + DELIMITER)
    }
  }

  private async handleCommand(req: ServerRequest): Promise<ServerResponse> {
    const handler = this.handlers[req.command as keyof typeof this.handlers]
    if (!handler) return { ok: false, error: `Unknown command: ${req.command}` }
    return handler(req)
  }

  private async resolveWindow(req: ServerRequest): Promise<{ targetId: string; windows: WindowInfo[] }> {
    const adapter = getAdapter(req.runtime)
    const windowArg = (req.args.window as string) || undefined
    const windows = await adapter.discover(req.port)

    if (windows.length === 0) {
      throw new Error('No windows found. Is the application running?')
    }

    let targetId: string

    if (windowArg) {
      const byId = windows.find(w => w.id === windowArg)
      const byTitle = windows.find(w => w.title.toLowerCase().includes(windowArg.toLowerCase()))
      const found = byId ?? byTitle
      if (!found) {
        throw new Error(`Window not found: "${windowArg}". Available: ${windows.map(w => `"${w.title}" (${w.id})`).join(', ')}`)
      }
      targetId = found.id
    } else {
      targetId = windows[0].id
    }

    return { targetId, windows }
  }

  private async getPageSession(req: ServerRequest, targetId: string): Promise<PageSession> {
    const connKey = `${req.port}:${targetId}`
    const cached = this.connections.get(connKey)
    if (cached) {
      if (cached.kind === 'page') return cached.session
      throw new Error(`Cached session for ${targetId} is runtime-only — cannot use page operations.`)
    }
    const adapter = getAdapter(req.runtime)
    const session = await adapter.connect(req.port, targetId, this.axTreeCache)
    this.connections.set(connKey, { kind: 'page', session })
    return session
  }

  private async getRuntimeSession(req: ServerRequest, target: TargetInfo): Promise<RuntimeSession> {
    const connKey = `${req.port}:${target.id}`
    const cached = this.connections.get(connKey)
    if (cached) return cached.session
    if (target.type === TargetType.Page || target.type === TargetType.Iframe) {
      // Page targets can serve runtime requests via their PageSession (it extends RuntimeSession).
      return this.getPageSession(req, target.id)
    }
    if (!RUNTIME_ONLY_TARGETS.has(target.type)) {
      throw new Error(`Target type "${target.type}" does not support eval/console.`)
    }
    const session = await connectToRuntime(req.port, target)
    this.connections.set(connKey, { kind: 'runtime', session })
    return session
  }

  private async handleDiscover(req: ServerRequest): Promise<ServerResponse> {
    const adapter = getAdapter(req.runtime)
    const windows = await adapter.discover(req.port)
    return {
      ok: true,
      data: { runtime: req.runtime, port: req.port, windows },
    }
  }

  private async handleLaunch(req: ServerRequest): Promise<ServerResponse> {
    const launchCmd = argStr(req.args, 'launch')
    const cwd = argStr(req.args, 'cwd')
    if (!launchCmd) return { ok: false, error: 'No launch command provided' }
    if (!cwd) return { ok: false, error: 'launch requires cwd to validate config' }

    const config = readConfig(resolve(cwd))
    if (!config || config.launch !== launchCmd) {
      return { ok: false, error: 'Launch command does not match project config' }
    }

    if (await isRunning(req.port)) {
      return { ok: true, data: 'Application already running' }
    }

    await launch(launchCmd, req.port, cwd)
    return { ok: true, data: 'Application launched and ready' }
  }

  private async handleDom(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)

    const filter = argStr(req.args, 'filter')
    const useText = argBool(req.args, 'text') ?? false

    const nodes = await conn.getAccessibilityTree()
    const { text, refs, nextRef } = formatAccessibilityTree(nodes, {
      filter,
      depth: resolveDepth(filter, argNum(req.args, 'depth')),
      startRef: this.refStore.getNextRef(),
    })

    this.refStore.store(refs, req.port, targetId, nextRef)

    if (useText && filter && text.startsWith('(no matching')) {
      return { ok: true, data: await textContentFallback(conn, filter) }
    }

    return { ok: true, data: text }
  }

  private async findByFilter(
    conn: PageSession,
    filter: string,
    req: ServerRequest,
    targetId: string,
    preferRoles?: Set<string>,
  ): Promise<{ backendDOMNodeId: number; name: string } | null> {
    const parsed = parseFilter(filter)

    if (parsed.kind === 'simple') {
      const queryNodes = await conn.queryAXTree({ accessibleName: parsed.name, role: parsed.role })
      if (queryNodes !== null) {
        if (queryNodes.length === 0) return null

        const startRef = this.refStore.getNextRef()
        let refNum = startRef
        const refs: Array<{ ref: number; backendDOMNodeId: number }> = []
        for (const node of queryNodes) {
          if (node.backendDOMNodeId) {
            refs.push({ ref: refNum++, backendDOMNodeId: node.backendDOMNodeId })
          }
        }
        this.refStore.store(refs, req.port, targetId, refNum)

        if (refs.length === 0) return null

        if (preferRoles) {
          for (let i = 0; i < queryNodes.length; i++) {
            const node = queryNodes[i]
            if (node.backendDOMNodeId && preferRoles.has(node.role?.value ?? '')) {
              return { backendDOMNodeId: node.backendDOMNodeId, name: node.name?.value ?? parsed.name }
            }
          }
        }
        const first = queryNodes.find(n => n.backendDOMNodeId)
        if (!first?.backendDOMNodeId) return null
        return { backendDOMNodeId: first.backendDOMNodeId, name: first.name?.value ?? parsed.name }
      }
    }

    const nodes = await conn.getAccessibilityTree()
    const { refs, nextRef } = formatAccessibilityTree(nodes, {
      filter,
      startRef: this.refStore.getNextRef(),
    })

    this.refStore.store(refs, req.port, targetId, nextRef)

    if (refs.length === 0) return null

    const nodeById = new Map<string, typeof nodes[0]>()
    for (const node of nodes) nodeById.set(node.nodeId, node)

    function resolveChildName(node: typeof nodes[0], depth = 5): string {
      if (depth <= 0 || !node.childIds) return ''
      for (const childId of node.childIds) {
        const child = nodeById.get(childId)
        if (!child) continue
        if (child.name?.value) return child.name.value
        const desc = child.properties?.find(p => p.name === 'description')
        if (desc?.value?.value && typeof desc.value.value === 'string') return desc.value.value as string
        const deeper = resolveChildName(child, depth - 1)
        if (deeper) return deeper
      }
      return ''
    }

    const nodeByDOMId = new Map<number, { name: string; role: string }>()
    for (const node of nodes) {
      if (node.backendDOMNodeId) {
        const name = node.name?.value || resolveChildName(node)
        nodeByDOMId.set(node.backendDOMNodeId, {
          name,
          role: node.role?.value ?? '',
        })
      }
    }

    const lowerFilter = filter.toLowerCase()

    if (preferRoles) {
      for (const entry of refs) {
        const info = nodeByDOMId.get(entry.backendDOMNodeId)
        if (info && preferRoles.has(info.role) && info.name.toLowerCase().includes(lowerFilter)) {
          return { backendDOMNodeId: entry.backendDOMNodeId, name: info.name }
        }
      }
    }

    for (let i = refs.length - 1; i >= 0; i--) {
      const info = nodeByDOMId.get(refs[i].backendDOMNodeId)
      if (info && info.name.toLowerCase().includes(lowerFilter)) {
        return { backendDOMNodeId: refs[i].backendDOMNodeId, name: info.name }
      }
    }

    const last = refs[refs.length - 1]
    const lastInfo = nodeByDOMId.get(last.backendDOMNodeId)
    return { backendDOMNodeId: last.backendDOMNodeId, name: lastInfo?.name ?? filter }
  }

  private async handleClick(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)
    const cacheKey = `${req.port}:${targetId}`

    if (req.args.pos && typeof req.args.pos === 'object') {
      const pos = req.args.pos as Record<string, unknown>
      const x = typeof pos.x === 'number' ? pos.x : 0
      const y = typeof pos.y === 'number' ? pos.y : 0
      await conn.clickAtPosition(x, y)
      this.axTreeCache.invalidate(cacheKey)
      return { ok: true, data: `Clicked at (${x}, ${y})` }
    }

    const clickFilter = argStr(req.args, 'filter')
    if (clickFilter) {
      const filter = clickFilter
      const CLICK_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio'])
      const found = await this.findByFilter(conn, filter, req, targetId, CLICK_ROLES)
      if (!found) {
        return { ok: false, error: `No element found matching "${filter}"` }
      }
      await conn.clickByNodeId(found.backendDOMNodeId)
      this.axTreeCache.invalidate(cacheKey)
      return { ok: true, data: `Clicked "${found.name}"` }
    }

    const ref = argNum(req.args, 'ref')
    if (ref === undefined) {
      return { ok: false, error: 'click requires --ref, --filter, or --pos' }
    }
    const entry = this.refStore.get(ref)
    if (!entry) {
      return { ok: false, error: `Invalid ref: ${ref}. Run \`agent-view dom\` to get fresh refs.` }
    }

    await conn.clickByNodeId(entry.backendDOMNodeId)
    this.axTreeCache.invalidate(cacheKey)
    return { ok: true, data: `Clicked ref ${ref}` }
  }

  private async handleDrag(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)
    const cacheKey = `${req.port}:${targetId}`

    const from = await this.resolveDragPoint(req, conn, 'from', { scrollIntoView: true })
    if ('error' in from) return { ok: false, error: from.error }
    const to = await this.resolveDragPoint(req, conn, 'to', { scrollIntoView: false })
    if ('error' in to) return { ok: false, error: to.error }

    const opts: DragOpts = {
      steps: argNum(req.args, 'steps'),
      button: parseMouseButton(argStr(req.args, 'button')),
      holdMs: argNum(req.args, 'holdMs'),
    }

    await conn.dragBetweenPositions(from.point, to.point, opts)
    this.axTreeCache.invalidate(cacheKey)
    return {
      ok: true,
      data: `Dragged (${from.point.x.toFixed(0)}, ${from.point.y.toFixed(0)}) → (${to.point.x.toFixed(0)}, ${to.point.y.toFixed(0)})`,
    }
  }

  private async resolveDragPoint(
    req: ServerRequest,
    conn: PageSession,
    side: 'from' | 'to',
    opts: { scrollIntoView: boolean },
  ): Promise<{ point: Point } | { error: string }> {
    const ref = argNum(req.args, `${side}Ref`)
    const x = argNum(req.args, `${side}X`)
    const y = argNum(req.args, `${side}Y`)

    if (ref !== undefined) {
      const entry = this.refStore.get(ref)
      if (!entry) {
        return { error: `Invalid --${side} ref: ${ref}. Run \`agent-view dom\` to get fresh refs.` }
      }
      const point = await conn.getBoxCenter(entry.backendDOMNodeId, opts)
      return { point }
    }

    if (x !== undefined && y !== undefined) {
      return { point: { x, y } }
    }

    return { error: `drag requires --${side} <ref> or --${side}-pos <x,y>` }
  }

  private async handleFill(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)
    const cacheKey = `${req.port}:${targetId}`

    const value = argStr(req.args, 'value')
    if (value === undefined) {
      return { ok: false, error: 'fill requires --value' }
    }

    const fillFilter = argStr(req.args, 'filter')
    if (fillFilter) {
      const filter = fillFilter
      const FILL_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'textarea'])
      const found = await this.findByFilter(conn, filter, req, targetId, FILL_ROLES)
      if (!found) {
        return { ok: false, error: `No element found matching "${filter}"` }
      }
      await conn.fillByNodeId(found.backendDOMNodeId, value)
      this.axTreeCache.invalidate(cacheKey)
      return { ok: true, data: `Filled "${found.name}" with "${value}"` }
    }

    const fillRef = argNum(req.args, 'ref')
    if (fillRef === undefined) {
      return { ok: false, error: 'fill requires --ref or --filter' }
    }
    const entry = this.refStore.get(fillRef)
    if (!entry) {
      return { ok: false, error: `Invalid ref: ${fillRef}. Run \`agent-view dom\` to get fresh refs.` }
    }

    await conn.fillByNodeId(entry.backendDOMNodeId, value)
    this.axTreeCache.invalidate(cacheKey)
    return { ok: true, data: `Filled ref ${fillRef} with "${value}"` }
  }

  private async handleWait(req: ServerRequest): Promise<ServerResponse> {
    const filter = argStr(req.args, 'filter')
    if (!filter) {
      return { ok: false, error: 'wait requires --filter' }
    }

    const timeout = argNum(req.args, 'timeout') ?? 10
    const interval = 500
    const maxAttempts = Math.ceil((timeout * 1000) / interval)

    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)

    for (let i = 0; i < maxAttempts; i++) {
      const nodes = await conn.getAccessibilityTree()
      const { refs, text, nextRef } = formatAccessibilityTree(nodes, {
        filter,
        startRef: this.refStore.getNextRef(),
      })

      if (refs.length > 0) {
        this.refStore.store(refs, req.port, targetId, nextRef)
        return { ok: true, data: text }
      }

      await new Promise(resolve => setTimeout(resolve, interval))
    }

    return { ok: false, error: `Timeout: "${filter}" not found after ${timeout}s` }
  }

  private async handleScreenshot(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)

    const scale = argNum(req.args, 'scale')
    const opts = scale !== undefined ? { scale } : undefined
    const buffer = await conn.captureScreenshot(opts)
    const ext = scale !== undefined && scale < 1 ? 'jpg' : 'png'
    const filename = `agent-view-screenshot-${Date.now()}.${ext}`
    const filepath = join(tmpdir(), filename)
    await writeFile(filepath, buffer)

    return { ok: true, data: filepath }
  }

  private async handleScene(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)

    const isDiff = argBool(req.args, 'diff') ?? false
    const cacheKey = `${req.port}:${targetId}`
    const sceneFilter = argStr(req.args, 'filter')
    const sceneDepth = argNum(req.args, 'depth')
    const sceneVerbose = argBool(req.args, 'verbose')

    if (isDiff) {
      const curr = await getRawScene(conn, req.engine)
      if (!curr) {
        return { ok: true, data: req.engine ? `No ${req.engine} scene found` : 'No WebGL engine configured' }
      }

      const prev = this.sceneCache.get(cacheKey)
      this.sceneCache.set(cacheKey, curr)

      if (!prev) {
        const text = await getSceneGraph(conn, req.engine, {
          filter: sceneFilter,
          depth: sceneDepth,
          verbose: sceneVerbose,
        })
        return { ok: true, data: text }
      }

      return { ok: true, data: diffScenes(prev, curr) }
    }

    const text = await getSceneGraph(conn, req.engine, {
      filter: sceneFilter,
      depth: sceneDepth,
      verbose: sceneVerbose,
    })

    return { ok: true, data: text }
  }

  private async handleSnap(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)

    const snapFilter = argStr(req.args, 'filter')
    const snapDepth = argNum(req.args, 'depth')

    const nodes = await conn.getAccessibilityTree()
    const { text: domText, refs, nextRef } = formatAccessibilityTree(nodes, {
      filter: snapFilter,
      depth: snapDepth,
      startRef: this.refStore.getNextRef(),
    })
    this.refStore.store(refs, req.port, targetId, nextRef)

    const sections = [`=== DOM ===\n${domText}`]

    if (req.engine) {
      const sceneText = await getSceneGraph(conn, req.engine, {
        filter: snapFilter,
        depth: snapDepth,
      })
      if (!sceneText.startsWith('No ')) {
        sections.push(`=== Scene ===\n${sceneText}`)
      }
    }

    return { ok: true, data: sections.join('\n\n') }
  }

  // ── New v0.3.0 commands ────────────────────────────────────────────────────

  private async handleTargets(req: ServerRequest): Promise<ServerResponse> {
    const targets = await listSupportedTargets(req.port)
    const typeFilter = argStrArray(req.args, 'types')
    const filtered = typeFilter && typeFilter.length > 0
      ? targets.filter(t => typeFilter.includes(t.type))
      : targets
    return { ok: true, data: { runtime: req.runtime, port: req.port, targets: filtered } }
  }

  private async resolveTarget(req: ServerRequest): Promise<TargetInfo> {
    const explicitId = argStr(req.args, 'target')
    const windowArg = argStr(req.args, 'window')
    const allTargets = await listSupportedTargets(req.port)

    if (explicitId) {
      const byId = allTargets.find(t => t.id === explicitId)
      if (byId) return byId
      const bySubstr = allTargets.find(
        t => t.title.toLowerCase().includes(explicitId.toLowerCase())
          || t.url.toLowerCase().includes(explicitId.toLowerCase()),
      )
      if (bySubstr) return bySubstr
      throw new Error(`Target not found: "${explicitId}". Run \`agent-view targets\` for the full list.`)
    }

    if (windowArg) {
      const pages = allTargets.filter(t => t.type === TargetType.Page)
      const byId = pages.find(t => t.id === windowArg)
      const byTitle = pages.find(t => t.title.toLowerCase().includes(windowArg.toLowerCase()))
      const found = byId ?? byTitle
      if (!found) {
        throw new Error(`Window not found: "${windowArg}".`)
      }
      return found
    }

    const firstPage = allTargets.find(t => t.type === TargetType.Page)
    if (!firstPage) throw new Error('No page targets found.')
    return firstPage
  }

  private async handleEval(req: ServerRequest): Promise<ServerResponse> {
    const cwd = argStr(req.args, 'cwd')
    if (!cwd) {
      return { ok: false, error: 'eval requires cwd to validate allowEval policy' }
    }
    const config = readConfig(resolve(cwd))
    if (!config?.allowEval) {
      return {
        ok: false,
        error: 'eval is disabled. Set "allowEval": true in agent-view.config.json to enable.',
      }
    }

    const expression = argStr(req.args, 'expression')
    if (!expression) return { ok: false, error: 'eval requires --expression' }

    const target = await this.resolveTarget(req)
    if (!RUNTIME_ONLY_TARGETS.has(target.type) && target.type !== TargetType.Page && target.type !== TargetType.Iframe) {
      return { ok: false, error: `Target type "${target.type}" does not support eval.` }
    }

    const session = await this.getRuntimeSession(req, target)
    const awaitPromise = argBool(req.args, 'await') ?? false
    const asJson = argBool(req.args, 'json') ?? false

    try {
      const value = await session.evaluate(expression, { awaitPromise })
      const formatted = asJson ? safeJSONStringify(value) : formatEvalValue(value)
      const capped = formatted.length > EVAL_OUTPUT_CAP
        ? `${formatted.slice(0, EVAL_OUTPUT_CAP)}\n... <${formatted.length - EVAL_OUTPUT_CAP} more bytes truncated>`
        : formatted
      return { ok: true, data: { target: { id: target.id, type: target.type }, result: capped } }
    } catch (err) {
      if (err instanceof EvaluationError) {
        return { ok: false, error: err.message + (err.stack ? `\n${err.stack}` : '') }
      }
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  private async handleWatchStreaming(req: ServerRequest, socket: Socket): Promise<void> {
    const writeFrame = (frame: WatchFrame): boolean => {
      if (socket.writableEnded || socket.destroyed) return false
      return socket.write(JSON.stringify(frame) + DELIMITER)
    }
    const writeError = (msg: string): void => {
      if (!socket.writableEnded && !socket.destroyed) {
        socket.end(JSON.stringify({ ok: false, error: msg } satisfies ServerResponse) + DELIMITER)
      }
    }

    const cwd = argStr(req.args, 'cwd')
    if (!cwd) return writeError('watch requires cwd to validate allowEval policy')
    const config = readConfig(resolve(cwd))
    if (!config?.allowEval) {
      return writeError('watch is disabled. Set "allowEval": true in agent-view.config.json to enable.')
    }

    const expression = argStr(req.args, 'expression')
    if (!expression) return writeError('watch requires --expression')

    const intervalRaw = argNum(req.args, 'intervalMs') ?? 250
    const intervalMs = Math.max(WATCH_MIN_INTERVAL_MS, intervalRaw)
    const durationS = argNum(req.args, 'durationS') ?? 30
    const maxChanges = argNum(req.args, 'maxChanges') ?? 10
    const until = argStr(req.args, 'until')

    if (maxChanges <= 0) return writeError('--max-changes must be > 0')
    if (durationS <= 0) return writeError('--duration must be > 0')

    let target: TargetInfo
    try {
      target = await this.resolveTarget(req)
    } catch (err) {
      return writeError(err instanceof Error ? err.message : String(err))
    }
    if (!RUNTIME_ONLY_TARGETS.has(target.type) && target.type !== TargetType.Page && target.type !== TargetType.Iframe) {
      return writeError(`Target type "${target.type}" does not support watch.`)
    }

    let session: RuntimeSession
    try {
      session = await this.getRuntimeSession(req, target)
    } catch (err) {
      return writeError(err instanceof Error ? err.message : String(err))
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }

    const watch = new WatchSession(session, {
      expression,
      intervalMs,
      durationS,
      maxChanges,
      until,
      emit: writeFrame,
    })
    this.activeWatches.add(watch)

    const cleanup = (): void => {
      if (!this.activeWatches.has(watch)) return
      this.activeWatches.delete(watch)
      if (!socket.writableEnded && !socket.destroyed) socket.end()
      if (this.activeWatches.size === 0) this.resetIdleTimer()
    }
    watch.onStop(cleanup)

    socket.on('close', () => {
      // Client closed (e.g. SIGINT). Stop watch with sigint reason if not already stopped.
      watch.stop(StopReason.Sigint, true)
    })
    socket.on('error', () => {
      watch.stop(StopReason.Sigint, true)
    })

    try {
      await watch.start()
    } catch (err) {
      writeFrame({ type: 'error', ts: new Date().toISOString(), message: err instanceof Error ? err.message : String(err) })
      watch.stop(StopReason.EvalFailed, false)
    }
  }

  private async handleConsole(req: ServerRequest): Promise<ServerResponse> {
    const cwd = argStr(req.args, 'cwd')
    const config = cwd ? readConfig(resolve(cwd)) : null
    const bufferSize = config?.consoleBufferSize ?? 500
    if (this.consoleStream.attachedCount === 0) {
      // Recreate with config-tuned capacity on first attach
      this.consoleStream = new ConsoleStream({ capacity: bufferSize })
    }

    if (argBool(req.args, 'clear')) {
      const targetId = argStr(req.args, 'target')
      this.consoleStream.clear(targetId)
      return { ok: true, data: 'Console buffer cleared' }
    }

    const requestedTypes = argStrArray(req.args, 'consoleTargets')
      ?? (config?.consoleTargets as string[] | undefined)
      ?? DEFAULT_CONSOLE_TARGETS

    const allowedTypes = new Set<TargetType>(
      requestedTypes
        .filter((t): t is string => typeof t === 'string')
        .filter((t): t is TargetType => Object.values(TargetType).includes(t as TargetType)) as TargetType[],
    )

    // Lazy attach: ensure every matching target has a session
    const all = await listSupportedTargets(req.port)
    const explicitTarget = argStr(req.args, 'target')
    if (process.env.AV_DEBUG_CONSOLE) {
      // eslint-disable-next-line no-console
      console.error(`[av-debug] handleConsole: targets=${all.length} explicit=${explicitTarget ?? 'none'} types=${[...allowedTypes].join(',')}`)
    }
    for (const t of all) {
      if (explicitTarget && t.id !== explicitTarget) continue
      if (!explicitTarget && !allowedTypes.has(t.type)) continue
      if (!RUNTIME_ONLY_TARGETS.has(t.type) && t.type !== TargetType.Page && t.type !== TargetType.Iframe) continue
      try {
        const session = await this.getRuntimeSession(req, t)
        this.consoleStream.attach(session)
        if (process.env.AV_DEBUG_CONSOLE) {
          // eslint-disable-next-line no-console
          console.error(`[av-debug] handleConsole: attached ${t.type}:${t.id.slice(0, 8)} (stream now has ${this.consoleStream.attachedCount})`)
        }
      } catch (err) {
        if (process.env.AV_DEBUG_CONSOLE) {
          // eslint-disable-next-line no-console
          console.error(`[av-debug] handleConsole: SKIP ${t.type}:${t.id.slice(0, 8)} — ${(err as Error).message}`)
        }
      }
    }

    const levelFilter = parseLevelFilter(argStrArray(req.args, 'levels'))
    const since = argNum(req.args, 'since')

    const follow = argBool(req.args, 'follow') ?? false
    if (follow) {
      const timeoutSec = argNum(req.args, 'timeout') ?? 10
      const collected: StampedConsoleMessage[] = this.consoleStream.drain({
        since,
        level: levelFilter,
        targetId: explicitTarget,
      })
      const seenAt = collected.length > 0 ? collected[collected.length - 1].ts : (since ?? Date.now())
      await new Promise<void>((resolveFollow) => {
        const dispose = this.consoleStream.subscribe((msg) => {
          if (explicitTarget && msg.targetId !== explicitTarget) return
          if (levelFilter && !levelFilter.has(msg.level)) return
          if (msg.ts <= seenAt) return
          collected.push(msg)
        })
        const timer = setTimeout(() => {
          dispose()
          resolveFollow()
        }, timeoutSec * 1000)
        timer.unref?.()
      })
      return { ok: true, data: formatConsoleMessages(collected) }
    }

    const messages = this.consoleStream.drain({
      since,
      level: levelFilter,
      targetId: explicitTarget,
    })
    return { ok: true, data: formatConsoleMessages(messages) }
  }

  private async handleStop(): Promise<ServerResponse> {
    setTimeout(() => this.shutdown(), 100)
    return { ok: true, data: 'Server stopping' }
  }

  private async shutdown(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    for (const watch of [...this.activeWatches]) {
      watch.stop(StopReason.ServerShutdown, false)
    }
    await unlink(TOKEN_PATH).catch(() => {})

    this.consoleStream.detach()
    for (const cached of this.connections.values()) {
      try { await cached.session.close() } catch { /* ignore */ }
    }
    this.connections.clear()

    this.server?.close()
    process.exit(0)
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseMouseButton(value: string | undefined): MouseButton | undefined {
  if (!value) return undefined
  const valid = Object.values(MouseButton) as string[]
  return valid.includes(value) ? (value as MouseButton) : undefined
}

function parseLevelFilter(levels: string[] | undefined): ReadonlySet<ConsoleLevel> | undefined {
  if (!levels || levels.length === 0) return undefined
  const valid = Object.values(ConsoleLevel) as string[]
  const set = new Set<ConsoleLevel>()
  for (const l of levels) {
    if (valid.includes(l)) set.add(l as ConsoleLevel)
  }
  return set.size > 0 ? set : undefined
}

function formatConsoleMessages(msgs: StampedConsoleMessage[]): string {
  if (msgs.length === 0) return '(no console messages)'
  return msgs.map(formatOneConsoleMessage).join('\n')
}

function formatOneConsoleMessage(msg: StampedConsoleMessage): string {
  const time = new Date(msg.ts).toISOString().slice(11, 23)
  const head = `[${time}] [${msg.level}] [${msg.targetType}:${msg.targetId.slice(0, 8)}] ${msg.text}`
  return msg.stack ? `${head}\n${msg.stack}` : head
}

function safeJSONStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function formatEvalValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return safeJSONStringify(value)
}
