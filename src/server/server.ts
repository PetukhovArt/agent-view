import { createServer, type Server, type Socket } from 'node:net'
import { writeFile, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { getAdapter } from '../adapters/registry.js'
import { isAppTarget } from '../adapters/target-filter.js'
import { formatAccessibilityTree, countAccessibilityNodes, diffDomText } from '../inspectors/dom/index.js'
import { getSceneGraph, getRawScene, diffScenes, type SceneNode } from '../inspectors/scene/index.js'
import { RefStore } from './ref-store.js'
import { launch, isRunning, installCDPErrorGuard, PortConflictError } from './launcher.js'
import { readConfig } from '../config/manager.js'
import { RuntimeType, WebGLEngine, ServerErrorCode, type ServerRequest, type ServerResponse, type WindowInfo } from '../types.js'
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
  type FileChooserArm,
} from '../cdp/types.js'
import { listSupportedTargets, connectToRuntime } from '../cdp/transport.js'
import { ConsoleStream, type StampedConsoleMessage } from '../cdp/_tests/console-stream.js'
import { NetworkStream, type StampedNetworkEntry } from '../cdp/network-stream.js'
import { formatNetworkList, formatNetworkDetail } from '../inspectors/network/index.js'
import { formatDialogStatus, describePolicy, describeArm } from '../inspectors/dialog/index.js'
import { buildTauriArmScript, buildTauriStatusScript, TauriShimResult, type TauriShimStatus } from './tauri-dialog-shim.js'
import { NetworkResourceType, type NetworkFilter } from '../cdp/types.js'
import { AxTreeCache } from '../cdp/ax-cache.js'
import { WatchSession } from './watch-session.js'
import { StopReason, WATCH_MIN_INTERVAL_MS, type WatchFrame } from '../inspectors/watch/index.js'
import { buildMatcher } from './pattern.js'
import {
  DEFAULT_TAIL_LINES,
  LogRecorder,
  filterLogLines,
  localStamp,
  parseSinceToken,
  readFeedLines,
  resolveLogFile,
  type ProbeSpec,
  type RecorderStatus,
} from './log-recorder.js'
import type { AgentViewConfig } from '../config/types.js'

const SERVER_PORT = 47922
/**
 * Every non-streaming command answers within this budget (plus its own `--timeout`,
 * for the commands that poll). A CDP call that never returns used to leave the CLI
 * hanging forever with no way back except killing the server.
 */
const REQUEST_DEADLINE_MS = envMs('AGENT_VIEW_REQUEST_DEADLINE_MS', 45_000)
/** `launch` legitimately blocks for minutes (60s Electron / 10min Tauri) — it bounds itself. */
const UNBOUNDED_COMMANDS: ReadonlySet<string> = new Set(['launch'])
const VALID_RUNTIMES = new Set<RuntimeType>(Object.values(RuntimeType))
const VALID_ENGINES = new Set<WebGLEngine>(Object.values(WebGLEngine))
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DELIMITER = '\n'
const MAX_BUFFER_SIZE = 1_048_576 // 1 MB
const TOKEN_DIR = join(homedir(), '.agent-view')
const TOKEN_PATH = join(TOKEN_DIR, 'token')
const EVAL_OUTPUT_CAP = 64 * 1024
const DEFAULT_CONSOLE_TARGETS: ReadonlyArray<TargetType> = [TargetType.Page, TargetType.SharedWorker, TargetType.ServiceWorker]
const DEFAULT_NETWORK_BUFFER = 200
const DEFAULT_NETWORK_MAX_LINES = 50
const NETWORK_PAGE_TARGETS = new Set<TargetType>([TargetType.Page, TargetType.Iframe])
/** Below this, a crop rect is a line of text rather than a container worth screenshotting. */
const TEXT_LINE_HEIGHT_PX = 32

const RUNTIME_ONLY_TARGETS = new Set<TargetType>([
  TargetType.SharedWorker,
  TargetType.ServiceWorker,
  TargetType.Worker,
])

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** Poll-based commands carry their own `--timeout` (seconds); the deadline must outlive it. */
export function requestDeadlineMs(command: string, args: Record<string, unknown>): number | null {
  if (UNBOUNDED_COMMANDS.has(command)) return null
  const ownTimeout = args['timeout']
  const extra = typeof ownTimeout === 'number' && ownTimeout > 0 ? ownTimeout * 1000 : 0
  return REQUEST_DEADLINE_MS + extra
}

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

/**
 * CDP takes any path without complaint and the app then reads an empty `File`,
 * so this is the only place a bad path stays diagnosable. A directory has to be
 * rejected too — it passes an existence check and produces that same empty
 * `File`, which is the failure the check exists to prevent.
 */
export function resolveUploadPath(cwd: string, raw: string): { path: string } | { error: string } {
  const abs = resolve(cwd, raw)
  let stats
  try {
    stats = statSync(abs)
  } catch {
    return { error: `File not found: ${abs}` }
  }
  if (!stats.isFile()) return { error: `Not a file: ${abs}` }
  return { path: abs }
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
  private domTextCache = new Map<string, string>()
  private axTreeCache = new AxTreeCache()
  private consoleStream = new ConsoleStream()
  private networkStream = new NetworkStream()
  private networkRefs = new Map<number, { targetId: string; requestId: string }>()
  private networkNextRef = 1
  private token = ''
  private activeWatches = new Set<WatchSession>()
  private logRecorder: LogRecorder | null = null

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
    network: (req: ServerRequest) => this.handleNetwork(req),
    logs: (req: ServerRequest) => this.handleLogs(req),
    upload: (req: ServerRequest) => this.handleUpload(req),
    dialog: (req: ServerRequest) => this.handleDialog(req),
    stop: () => this.handleStop(),
  } as const satisfies Record<string, (req: ServerRequest) => Promise<ServerResponse>>

  private readonly streamingCommands: ReadonlySet<string> = new Set(['watch'])
  private readonly validCommands: ReadonlySet<string> = new Set([...Object.keys(this.handlers), ...this.streamingCommands])

  async start(): Promise<void> {
    installCDPErrorGuard()
    mkdirSync(TOKEN_DIR, { recursive: true })
    this.token = randomBytes(32).toString('hex')

    // Publish the token only after winning the port. A server that loses the bind race
    // must not overwrite the live server's token — that leaves every CLI call
    // "Unauthorized" with no way back, since nobody knows the running server's token.
    await new Promise<void>((resolve, reject) => {
      this.server = createServer((socket: Socket) => this.handleSocket(socket))
      this.server.on('error', reject)
      this.server.listen(SERVER_PORT, '127.0.0.1', () => {
        this.resetIdleTimer()
        resolve()
      })
    })
    await writeFile(TOKEN_PATH, this.token, { mode: 0o600 })
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.activeWatches.size > 0 || this.logRecorder !== null) {
      // Pause idle shutdown while streaming handlers or a log recording are alive —
      // a recording that dies at the 5-min mark loses exactly the long scenario it was for.
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
      // `stop` needs no token: it only shuts this server down (any local process can do
      // that via the OS anyway), and it is the recovery path when the token file no
      // longer matches a running server.
      if (request.command !== 'stop' && request.token !== this.token) {
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
      const response = await this.runWithDeadline(request)
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

  /**
   * Answer within the deadline no matter what CDP does. On expiry the cached sessions
   * for that port are dropped, so the next command reconnects instead of queueing
   * behind the same dead socket.
   */
  private async runWithDeadline(req: ServerRequest): Promise<ServerResponse> {
    const budget = requestDeadlineMs(req.command, req.args)
    if (budget === null) return this.handleCommand(req)

    const pending = this.handleCommand(req)
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = Symbol('expired')
    try {
      const outcome = await Promise.race([
        pending,
        new Promise<typeof expired>((resolveRace) => {
          timer = setTimeout(() => resolveRace(expired), budget)
        }),
      ])
      if (outcome !== expired) return outcome
    } finally {
      if (timer) clearTimeout(timer)
    }

    // The abandoned handler may still reject later — never let it reach the process guard.
    pending.catch(() => { /* orphaned after deadline */ })
    this.dropSessionsForPort(req.port)
    return {
      ok: false,
      error: `Timed out after ${Math.round(budget / 1000)}s waiting for CDP (command: ${req.command}, port: ${req.port}). `
        + `Dropped cached CDP sessions for that port — retry the command. `
        + `If it keeps timing out, the app's DevTools endpoint is wedged: restart the app, or run \`agent-view stop\`.`,
      code: ServerErrorCode.CDPTimeout,
    }
  }

  private evictSession(connKey: string): void {
    const cached = this.connections.get(connKey)
    if (!cached) return
    this.connections.delete(connKey)
    const targetId = cached.session.target.id
    this.consoleStream.detach(targetId)
    this.networkStream.detach(targetId)
    this.axTreeCache.invalidate(connKey)
    cached.session.close().catch(() => { /* socket already gone */ })
  }

  private dropSessionsForPort(port: number): void {
    const prefix = `${port}:`
    for (const connKey of [...this.connections.keys()]) {
      if (connKey.startsWith(prefix)) this.evictSession(connKey)
    }
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
      const q = windowArg.toLowerCase()
      const byId = windows.find(w => w.id === windowArg)
      const byIdPrefix = q.length >= 4 ? windows.filter(w => w.id.toLowerCase().startsWith(q)) : []
      const byTitle = windows.find(w => w.title.toLowerCase().includes(q))
      const found = byId ?? (byIdPrefix.length === 1 ? byIdPrefix[0] : undefined) ?? byTitle
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
    session.onDisconnect(() => this.evictSession(connKey))
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
    session.onDisconnect(() => this.evictSession(connKey))
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
      await this.ensureNetworkAttached(req, config).catch(() => {})
      return { ok: true, data: 'Application already running' }
    }

    try {
      await launch(launchCmd, req.port, cwd, req.runtime)
    } catch (err) {
      if (err instanceof PortConflictError) {
        return {
          ok: false,
          error: err.message,
          code: ServerErrorCode.PortConflict,
          data: err.conflict,
        }
      }
      throw err
    }
    // Eager attach (ADR 0002): start capture the moment the app is ready, so page-load
    // traffic is not missed. Best-effort — a launch must not fail on a capture hiccup.
    await this.ensureNetworkAttached(req, config).catch(() => {})
    return { ok: true, data: 'Application launched and ready' }
  }

  /**
   * Connect+attach NetworkStream to every page/iframe target. Idempotent per target.
   * Recreates the stream with config-tuned capacity/captureBody while it is still empty,
   * mirroring the consoleStream pattern.
   */
  private async ensureNetworkAttached(req: ServerRequest, config: { networkBufferSize?: number; captureBody?: boolean } | null): Promise<void> {
    if (this.networkStream.attachedCount === 0) {
      this.networkStream = new NetworkStream({
        capacity: config?.networkBufferSize ?? DEFAULT_NETWORK_BUFFER,
        captureBody: config?.captureBody ?? false,
      })
    }
    const all = await listSupportedTargets(req.port)
    for (const t of all) {
      if (!NETWORK_PAGE_TARGETS.has(t.type)) continue
      try {
        const session = await this.getPageSession(req, t.id)
        await this.networkStream.attach(session)
      } catch { /* a single unreachable target shouldn't abort capture */ }
    }
  }

  private async handleDom(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)

    const filter = argStr(req.args, 'filter')
    const useText = argBool(req.args, 'text') ?? false
    const compact = argBool(req.args, 'compact') ?? false
    const useCount = argBool(req.args, 'count') ?? false
    const isDiff = argBool(req.args, 'diff') ?? false
    const cacheKey = `${req.port}:${targetId}`

    const { nodes, fromCache } = await conn.getAccessibilityTreeMeta()

    if (useCount) {
      const { count } = countAccessibilityNodes(nodes, {
        filter,
        depth: resolveDepth(filter, argNum(req.args, 'depth')),
      })
      return { ok: true, data: String(count) }
    }

    const { text, refs, nextRef } = formatAccessibilityTree(nodes, {
      filter,
      depth: resolveDepth(filter, argNum(req.args, 'depth')),
      startRef: this.refStore.getNextRef(),
      compact,
      maxLines: argNum(req.args, 'maxLines'),
    })

    this.refStore.store(refs, req.port, targetId, nextRef)

    if (isDiff) {
      const prev = this.domTextCache.get(cacheKey)
      this.domTextCache.set(cacheKey, text)

      if (prev === undefined) {
        // First call — no snapshot yet, return full tree
        return { ok: true, data: text }
      }

      return { ok: true, data: diffDomText(prev, text) }
    }

    if (useText && filter && text.startsWith('(no matching')) {
      return { ok: true, data: await textContentFallback(conn, filter) }
    }

    const data = fromCache ? `[cache]\n${text}` : text
    return { ok: true, data }
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

    const clicks = argBool(req.args, 'double') ? 2 : 1
    const clickOpts = clicks > 1 ? { clicks } : undefined
    const verb = clicks > 1 ? 'Double-clicked' : 'Clicked'

    if (req.args.pos && typeof req.args.pos === 'object') {
      const pos = req.args.pos as Record<string, unknown>
      const x = typeof pos.x === 'number' ? pos.x : 0
      const y = typeof pos.y === 'number' ? pos.y : 0
      await conn.clickAtPosition(x, y, clickOpts)
      this.axTreeCache.invalidate(cacheKey)
      return { ok: true, data: `${verb} at (${x}, ${y})` }
    }

    const clickFilter = argStr(req.args, 'filter')
    if (clickFilter) {
      const filter = clickFilter
      const CLICK_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio'])
      const found = await this.findByFilter(conn, filter, req, targetId, CLICK_ROLES)
      if (!found) {
        return { ok: false, error: `No element found matching "${filter}"` }
      }
      await conn.clickByNodeId(found.backendDOMNodeId, clickOpts)
      this.axTreeCache.invalidate(cacheKey)
      return { ok: true, data: `${verb} "${found.name}"` }
    }

    const ref = argNum(req.args, 'ref')
    if (ref === undefined) {
      return { ok: false, error: 'click requires --ref, --filter, or --pos' }
    }
    const entry = this.refStore.get(ref)
    if (!entry) {
      return { ok: false, error: `Invalid ref: ${ref}. Run \`agent-view dom\` to get fresh refs.` }
    }

    await conn.clickByNodeId(entry.backendDOMNodeId, clickOpts)
    this.axTreeCache.invalidate(cacheKey)
    return { ok: true, data: `${verb} ref ${ref}` }
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

  /**
   * Puts files straight into a file input. The native chooser never opens, so
   * there is nothing to close and nothing to arm — this is the cheapest path
   * whenever the input exists in the DOM before the click.
   */
  private async handleUpload(req: ServerRequest): Promise<ServerResponse> {
    const rawFiles = argStrArray(req.args, 'files') ?? []
    if (rawFiles.length === 0) {
      return { ok: false, error: 'upload requires at least one --file' }
    }

    const cwd = argStr(req.args, 'cwd') ?? process.cwd()
    const files: string[] = []
    for (const raw of rawFiles) {
      const resolved = resolveUploadPath(cwd, raw)
      if ('error' in resolved) return { ok: false, error: resolved.error }
      files.push(resolved.path)
    }

    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)
    const cacheKey = `${req.port}:${targetId}`
    const label = files.map(f => f.split(/[\\/]/).pop()).join(', ')

    const selector = argStr(req.args, 'selector')
    if (selector) {
      const found = await conn.uploadBySelector(selector, files)
      if (!found) return { ok: false, error: `No element matches selector "${selector}"` }
      this.axTreeCache.invalidate(cacheKey)
      return { ok: true, data: `Set ${files.length} file(s) on "${selector}": ${label}` }
    }

    // No `--filter` here, unlike `click`/`fill`: an accessible name resolves to
    // whatever node carries it, which for an upload control is the label or the
    // button, not the `<input type=file>` behind it. Setting files on the wrong
    // node fails deep inside CDP. `--selector` addresses the input itself.
    const ref = argNum(req.args, 'ref')
    if (ref === undefined) {
      return { ok: false, error: 'upload requires --selector or --ref' }
    }
    const entry = this.refStore.get(ref)
    if (!entry) {
      return { ok: false, error: `Invalid ref: ${ref}. Run \`agent-view dom\` to get fresh refs.` }
    }
    await conn.uploadByNodeId(entry.backendDOMNodeId, files)
    this.axTreeCache.invalidate(cacheKey)
    return { ok: true, data: `Set ${files.length} file(s) on ref ${ref}: ${label}` }
  }

  /**
   * `dialog` covers JS modals only — `alert`/`confirm`/`prompt`/`beforeunload`.
   * They are answered automatically the moment they open (see
   * `attachJsDialogSubscription`); the commands here read that log, change the
   * standing answer, and force an answer for a dialog that was already open
   * before agent-view attached.
   */
  private async handleDialog(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)
    const action = argStr(req.args, 'action') ?? 'status'
    const text = argStr(req.args, 'text')

    if (action === 'accept' || action === 'dismiss') {
      const accept = action === 'accept'
      try {
        await conn.answerJsDialog(accept, text)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        return { ok: false, error: `No JS dialog is showing on this window (${detail}).` }
      }
      const suffix = accept && text !== undefined ? ` with "${text}"` : ''
      return { ok: true, data: `Dialog ${accept ? 'accepted' : 'dismissed'}${suffix}.` }
    }

    if (action === 'policy') {
      const mode = argStr(req.args, 'mode')
      if (mode !== 'accept' && mode !== 'dismiss') {
        return { ok: false, error: 'dialog policy requires accept or dismiss' }
      }
      // Storing prompt text alongside a dismiss would be dead state the status
      // output cannot show — rejecting it keeps what is stored and what is
      // reported the same thing.
      if (mode === 'dismiss' && text !== undefined) {
        return { ok: false, error: '--text applies to accept only; a dismissed prompt returns null' }
      }
      const policy = { accept: mode === 'accept', ...(text === undefined ? {} : { promptText: text }) }
      conn.setJsDialogPolicy(policy)
      return { ok: true, data: `JS dialog policy: ${describePolicy(policy)}` }
    }

    if (action === 'arm' || action === 'disarm') {
      return this.armFileChooser(req, conn, action === 'arm')
    }

    if (action !== 'status') {
      return { ok: false, error: `Unknown dialog action: "${action}". Use status, accept, dismiss, policy, arm, or disarm.` }
    }

    const shim = await this.readTauriShimStatus(conn)
    const status = {
      policy: conn.getJsDialogPolicy(),
      dialogs: conn.recentJsDialogs(),
      chooserArm: conn.fileChooserArm(),
      choosers: conn.recentFileChoosers(),
      tauriPatched: shim.patched,
      // The shim's arm lives in the page, the CDP arm lives in the session —
      // different lifetimes. A dropped session leaves the page still armed, and
      // reporting only the CDP half would call that "not armed".
      tauriArmed: shim.armed,
    }
    return { ok: true, data: formatDialogStatus(status, localStamp) }
  }

  /**
   * Arms both engines at once. Which one fires depends on how the app opens its
   * dialog — a webview `<input>` goes through CDP, `@tauri-apps/plugin-dialog`
   * goes through the IPC shim — and the caller has no reason to know which.
   */
  private async armFileChooser(req: ServerRequest, conn: PageSession, arming: boolean): Promise<ServerResponse> {
    let arm: FileChooserArm | null = null

    if (arming) {
      const cancel = argBool(req.args, 'cancel') ?? false
      const rawFiles = argStrArray(req.args, 'files') ?? []
      if (cancel && rawFiles.length > 0) {
        return { ok: false, error: 'dialog arm takes either --file or --cancel, not both' }
      }
      if (!cancel && rawFiles.length === 0) {
        return { ok: false, error: 'dialog arm requires at least one --file, or --cancel' }
      }
      if (cancel) {
        arm = { kind: 'cancel' }
      } else {
        const cwd = argStr(req.args, 'cwd') ?? process.cwd()
        const files: string[] = []
        for (const raw of rawFiles) {
          const resolved = resolveUploadPath(cwd, raw)
          if ('error' in resolved) return { ok: false, error: resolved.error }
          files.push(resolved.path)
        }
        arm = { kind: 'files', files }
      }
    }

    // The IPC shim goes first because it is the failure-prone half: it runs a
    // script inside the page. Arming CDP only after it succeeds keeps the two
    // engines from disagreeing — a reported failure must not leave a live
    // intercept behind, which would silently swallow a later real chooser.
    const tauri = await conn.evaluate(buildTauriArmScript(arm))
    try {
      await conn.armFileChooser(arm)
    } catch (err) {
      await conn.evaluate(buildTauriArmScript(null)).catch(() => { /* best effort */ })
      throw err
    }
    const engines = tauri === TauriShimResult.Armed ? 'CDP + Tauri IPC' : 'CDP'

    if (!arming) return { ok: true, data: `File chooser disarmed (${engines}).` }
    return { ok: true, data: `File chooser ${describeArm(arm)} (${engines}). Arm before the click that opens it.` }
  }

  private async readTauriShimStatus(conn: PageSession): Promise<TauriShimStatus> {
    try {
      return await conn.evaluate(buildTauriStatusScript()) as TauriShimStatus
    } catch {
      return { patched: false, armed: false, fired: [] }
    }
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

  private async captureScreenshotToFile(
    conn: PageSession,
    opts: { scale?: number; clip?: { x: number; y: number; width: number; height: number } } = {},
  ): Promise<string> {
    const { buffer, format } = await conn.captureScreenshot(opts)
    const ext = format === 'jpeg' ? 'jpg' : format
    const filename = `agent-view-screenshot-${Date.now()}.${ext}`
    const filepath = join(tmpdir(), filename)
    await writeFile(filepath, buffer)
    return filepath
  }

  private async handleScreenshot(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)

    const scale = argNum(req.args, 'scale')
    const cropFilter = argStr(req.args, 'crop')

    let warning: string | undefined
    let clip: { x: number; y: number; width: number; height: number } | undefined

    if (cropFilter !== undefined) {
      const found = await this.findByFilter(conn, cropFilter, req, targetId)
      if (!found) {
        warning = `crop filter '${cropFilter}' matched nothing — capturing full window`
      } else {
        const cropUp = argNum(req.args, 'cropUp') ?? 0
        clip = await conn.getBoxRect(found.backendDOMNodeId, { scrollIntoView: true, ancestorLevels: cropUp })
        if (clip.height < TEXT_LINE_HEIGHT_PX && cropUp === 0) {
          warning = `crop matched a text-sized box (${Math.round(clip.width)}×${Math.round(clip.height)}) — `
            + `pass --crop-up 1 (or 2) to capture the surrounding container instead`
        }
      }
    }

    const filepath = await this.captureScreenshotToFile(conn, { scale, clip })
    return { ok: true, data: filepath, warning }
  }

  private async handleScene(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)

    const isDiff = argBool(req.args, 'diff') ?? false
    const cacheKey = `${req.port}:${targetId}`
    const sceneFilter = argStr(req.args, 'filter')
    const sceneDepth = argNum(req.args, 'depth')
    const sceneVerbose = argBool(req.args, 'verbose')
    const sceneCompact = argBool(req.args, 'compact')

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
          compact: sceneCompact,
        })
        return { ok: true, data: text }
      }

      return { ok: true, data: diffScenes(prev, curr) }
    }

    const text = await getSceneGraph(conn, req.engine, {
      filter: sceneFilter,
      depth: sceneDepth,
      verbose: sceneVerbose,
      compact: sceneCompact,
    })

    return { ok: true, data: text }
  }

  private async handleSnap(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getPageSession(req, targetId)

    const snapFilter = argStr(req.args, 'filter')
    const snapDepth = argNum(req.args, 'depth')
    const snapScale = argNum(req.args, 'scale')

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

    if (snapScale !== undefined) {
      const filepath = await this.captureScreenshotToFile(conn, { scale: snapScale })
      sections.push(`=== Screenshot ===\n${filepath}`)
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
      const match = matchTarget(allTargets, explicitId)
      if (match.kind === 'found') return match.target
      throw new Error(describeTargetMatchFailure(explicitId, match))
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

    const firstPage = allTargets.find(isAppTarget) ?? allTargets.find(t => t.type === TargetType.Page)
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

  /**
   * Console target types for this request: explicit arg → project config → defaults.
   */
  private resolveConsoleTypes(req: ServerRequest, config: AgentViewConfig | null): Set<TargetType> {
    const requested = argStrArray(req.args, 'consoleTargets')
      ?? (config?.consoleTargets as string[] | undefined)
      ?? DEFAULT_CONSOLE_TARGETS
    return new Set<TargetType>(
      requested
        .filter((t): t is string => typeof t === 'string')
        .filter((t): t is TargetType => Object.values(TargetType).includes(t as TargetType)) as TargetType[],
    )
  }

  /**
   * Lazy-attach: give every matching target a session feeding `consoleStream`. Idempotent,
   * and re-run on every console/logs call — that is how a restarted worker (fresh target id)
   * rejoins the feed. Returns the sessions now attached.
   */
  private async attachConsoleTargets(
    req: ServerRequest,
    opts: { targets: TargetInfo[]; allowedTypes: Set<TargetType>; targetId?: string },
  ): Promise<RuntimeSession[]> {
    const sessions: RuntimeSession[] = []
    if (process.env.AV_DEBUG_CONSOLE) {
      // eslint-disable-next-line no-console
      console.error(`[av-debug] attachConsoleTargets: targets=${opts.targets.length} explicit=${opts.targetId ?? 'none'} types=${[...opts.allowedTypes].join(',')}`)
    }
    for (const t of opts.targets) {
      if (opts.targetId && t.id !== opts.targetId) continue
      if (!opts.targetId && !opts.allowedTypes.has(t.type)) continue
      if (!RUNTIME_ONLY_TARGETS.has(t.type) && t.type !== TargetType.Page && t.type !== TargetType.Iframe) continue
      try {
        const session = await this.getRuntimeSession(req, t)
        this.consoleStream.attach(session)
        sessions.push(session)
        if (process.env.AV_DEBUG_CONSOLE) {
          // eslint-disable-next-line no-console
          console.error(`[av-debug] attachConsoleTargets: attached ${t.type}:${t.id.slice(0, 8)} (stream now has ${this.consoleStream.attachedCount})`)
        }
      } catch (err) {
        if (process.env.AV_DEBUG_CONSOLE) {
          // eslint-disable-next-line no-console
          console.error(`[av-debug] attachConsoleTargets: SKIP ${t.type}:${t.id.slice(0, 8)} — ${(err as Error).message}`)
        }
      }
    }
    return sessions
  }

  private async handleConsole(req: ServerRequest): Promise<ServerResponse> {
    const cwd = argStr(req.args, 'cwd')
    const config = cwd ? readConfig(resolve(cwd)) : null
    const bufferSize = config?.consoleBufferSize ?? 500
    if (this.consoleStream.attachedCount === 0 && this.logRecorder === null) {
      // Recreate with config-tuned capacity on first attach. Never while recording — the
      // recorder's subscription lives on the stream instance and would be dropped silently.
      this.consoleStream = new ConsoleStream({ capacity: bufferSize })
    }

    const targetQuery = argStr(req.args, 'target')

    // Fuzzy-resolve the target query once (id exact → title substring → url substring)
    const all = await listSupportedTargets(req.port)
    let resolvedTargetId: string | undefined
    if (targetQuery) {
      const match = matchTarget(all, targetQuery)
      if (match.kind !== 'found') {
        return { ok: false, error: describeTargetMatchFailure(targetQuery, match) }
      }
      resolvedTargetId = match.target.id
    }

    if (argBool(req.args, 'clear')) {
      this.consoleStream.clear(resolvedTargetId)
      return { ok: true, data: 'Console buffer cleared' }
    }

    await this.attachConsoleTargets(req, {
      targets: all,
      allowedTypes: this.resolveConsoleTypes(req, config),
      targetId: resolvedTargetId,
    })

    const levelFilter = parseLevelFilter(argStrArray(req.args, 'levels'))
    const since = argNum(req.args, 'since')

    const follow = argBool(req.args, 'follow') ?? false
    const untilPattern = argStr(req.args, 'until')

    if (untilPattern && !follow) {
      return { ok: false, error: '--until requires --follow' }
    }

    if (follow) {
      const timeoutSec = argNum(req.args, 'timeout') ?? 10
      const collected: StampedConsoleMessage[] = this.consoleStream.drain({
        since,
        level: levelFilter,
        targetId: resolvedTargetId,
      })
      const seenAt = collected.length > 0 ? collected[collected.length - 1].ts : (since ?? Date.now())

      const matcher = untilPattern ? buildMatcher(untilPattern) : null

      // Check if pattern already matched in buffered messages
      const earlyMatch = matcher ? collected.findIndex(m => matcher(m.text)) : -1

      if (earlyMatch !== -1) {
        return { ok: true, data: formatConsoleMessages(collected.slice(0, earlyMatch + 1)) }
      }

      const timedOut = await new Promise<boolean>((resolveFollow) => {
        const dispose = this.consoleStream.subscribe((msg) => {
          if (resolvedTargetId && msg.targetId !== resolvedTargetId) return
          if (levelFilter && !levelFilter.has(msg.level)) return
          if (msg.ts <= seenAt) return
          collected.push(msg)
          if (matcher && matcher(msg.text)) {
            clearTimeout(timer)
            dispose()
            resolveFollow(false)
          }
        })
        const timer = setTimeout(() => {
          dispose()
          resolveFollow(true)
        }, timeoutSec * 1000)
        timer.unref?.()
      })

      if (timedOut && matcher) {
        return { ok: false, error: `Timeout: pattern not seen in ${timeoutSec}s` }
      }

      return { ok: true, data: formatConsoleMessages(collected) }
    }

    const messages = this.consoleStream.drain({
      since,
      level: levelFilter,
      targetId: resolvedTargetId,
    })
    return { ok: true, data: formatConsoleMessages(messages) }
  }

  private async handleNetwork(req: ServerRequest): Promise<ServerResponse> {
    const cwd = argStr(req.args, 'cwd')
    const config = cwd ? readConfig(resolve(cwd)) : null
    await this.ensureNetworkAttached(req, config)

    let resolvedTargetId: string | undefined
    const targetQuery = argStr(req.args, 'target') ?? argStr(req.args, 'window')
    if (targetQuery) {
      const all = await listSupportedTargets(req.port)
      const match = matchTarget(all, targetQuery)
      if (match.kind !== 'found') {
        return { ok: false, error: describeTargetMatchFailure(targetQuery, match) }
      }
      resolvedTargetId = match.target.id
    }

    const reqN = argNum(req.args, 'req')
    if (reqN !== undefined) {
      const ref = this.networkRefs.get(reqN)
      if (!ref) {
        return { ok: false, error: `Invalid req: ${reqN}. Run \`agent-view network\` to get fresh handles.` }
      }
      const entry = this.networkStream.getEntry(ref.targetId, ref.requestId)
      if (!entry) {
        return { ok: false, error: `Request ${reqN} is no longer buffered (evicted or app restarted).` }
      }
      return { ok: true, data: formatNetworkDetail(entry, { rawHeaders: argBool(req.args, 'rawHeaders') ?? false }) }
    }

    if (argBool(req.args, 'clear')) {
      this.networkStream.clear(resolvedTargetId)
      return { ok: true, data: 'Network buffer cleared' }
    }

    const filter: NetworkFilter = {
      targetId: resolvedTargetId,
      since: argNum(req.args, 'since'),
      url: argStr(req.args, 'url'),
      method: parseMethodFilter(argStrArray(req.args, 'method')),
      type: parseTypeFilter(argStrArray(req.args, 'type')),
      ...parseStatusFilter(argStrArray(req.args, 'status')),
    }

    const maxLines = argNum(req.args, 'maxLines') ?? DEFAULT_NETWORK_MAX_LINES
    const follow = argBool(req.args, 'follow') ?? false
    const untilPattern = argStr(req.args, 'until')
    if (untilPattern && !follow) {
      return { ok: false, error: '--until requires --follow' }
    }

    if (follow) {
      return this.followNetwork(req, filter, maxLines, untilPattern)
    }

    const entries = this.networkStream.drain(filter)
    return { ok: true, data: this.renderNetworkList(entries, maxLines) }
  }

  private renderNetworkList(entries: StampedNetworkEntry[], maxLines: number): string {
    const { text, refs, nextRef } = formatNetworkList(entries, { startRef: this.networkNextRef, maxLines })
    this.networkRefs.clear()
    for (const r of refs) this.networkRefs.set(r.ref, { targetId: r.targetId, requestId: r.requestId })
    this.networkNextRef = nextRef
    return text
  }

  private async followNetwork(
    req: ServerRequest,
    filter: NetworkFilter,
    maxLines: number,
    untilPattern: string | undefined,
  ): Promise<ServerResponse> {
    const timeoutSec = argNum(req.args, 'timeout') ?? 10
    const matcher = untilPattern ? buildMatcher(untilPattern) : null
    const matchText = (e: StampedNetworkEntry): string =>
      `${e.method ?? (e.isWebSocket ? 'WS' : e.isEventSource ? 'SSE' : '')} ${e.status ?? e.state} ${e.url}`

    if (matcher) {
      const pre = this.networkStream.drain(filter)
      const hit = pre.findIndex(e => matcher(matchText(e)))
      if (hit !== -1) return { ok: true, data: this.renderNetworkList(pre.slice(0, hit + 1), maxLines) }
    }

    const matched = await new Promise<boolean>((resolveFollow) => {
      const dispose = matcher
        ? this.networkStream.subscribe(() => {
            const cur = this.networkStream.drain(filter)
            if (cur.some(e => matcher(matchText(e)))) {
              clearTimeout(timer)
              dispose()
              resolveFollow(true)
            }
          })
        : (): void => {}
      const timer = setTimeout(() => {
        dispose()
        resolveFollow(false)
      }, timeoutSec * 1000)
      timer.unref?.()
    })

    if (matcher && !matched) {
      return { ok: false, error: `Timeout: pattern not seen in ${timeoutSec}s` }
    }

    const entries = this.networkStream.drain(filter)
    return { ok: true, data: this.renderNetworkList(entries, maxLines) }
  }

  /**
   * Durable side of the console feed. `console` answers from a ring buffer that dies with the
   * server; `logs` appends every message from every attached target to one file, so a diagnosis
   * can grep a timeline that outlives the scenario (and the 5-min idle shutdown).
   */
  private async handleLogs(req: ServerRequest): Promise<ServerResponse> {
    const action = argStr(req.args, 'action') ?? 'tail'
    const cwd = argStr(req.args, 'cwd')
    const projectDir = cwd ? resolve(cwd) : process.cwd()
    const config = cwd ? readConfig(projectDir) : null
    const explicitFile = argStr(req.args, 'file')
    // An active recording owns the feed path — only an explicit --file overrides it.
    const file = explicitFile
      ? resolveLogFile(projectDir, explicitFile)
      : this.logRecorder?.file ?? resolveLogFile(projectDir, config?.logFile)

    switch (action) {
      case 'start': return this.startLogRecording(req, config, file)
      case 'stop': return this.stopLogRecording()
      case 'status': return { ok: true, data: this.logRecorder ? formatRecorderStatus(this.logRecorder.status()) : formatIdleFeed(file) }
      case 'clear': return this.clearLogFeed(file)
      case 'tail': return this.tailLogFeed(req, file)
      default: return { ok: false, error: `Unknown logs action: ${action}` }
    }
  }

  private async startLogRecording(req: ServerRequest, config: AgentViewConfig | null, file: string): Promise<ServerResponse> {
    if (this.logRecorder) {
      if (this.logRecorder.file === file) {
        return { ok: true, data: `Already recording\n${formatRecorderStatus(this.logRecorder.status())}` }
      }
      return { ok: false, error: `Already recording into ${this.logRecorder.file}. Run \`agent-view logs stop\` first.` }
    }

    const probes = parseProbes(req.args)
    if (probes.length > 0 && !config?.allowEval) {
      return { ok: false, error: 'logs --probe evaluates arbitrary JS. Set "allowEval": true in agent-view.config.json to enable it.' }
    }

    const targetQuery = argStr(req.args, 'target')
    let resolvedTargetId: string | undefined
    const all = await listSupportedTargets(req.port)
    if (targetQuery) {
      const match = matchTarget(all, targetQuery)
      if (match.kind !== 'found') {
        return { ok: false, error: describeTargetMatchFailure(targetQuery, match) }
      }
      resolvedTargetId = match.target.id
    }

    if (this.consoleStream.attachedCount === 0) {
      this.consoleStream = new ConsoleStream({ capacity: config?.consoleBufferSize ?? 500 })
    }

    const allowedTypes = this.resolveConsoleTypes(req, config)
    const recorder = new LogRecorder({
      file,
      levels: parseLevelFilter(argStrArray(req.args, 'levels')),
      targetId: resolvedTargetId,
      rescanMs: argNum(req.args, 'rescan'),
      maxBytes: config?.logMaxBytes,
      truncate: argBool(req.args, 'truncate') ?? false,
      probes,
      rescan: async () => this.attachConsoleTargets(req, {
        targets: await listSupportedTargets(req.port),
        allowedTypes,
        targetId: resolvedTargetId,
      }),
      subscribe: (handler) => this.consoleStream.subscribe(handler),
    })

    try {
      await recorder.start()
    } catch (err) {
      recorder.stop('start failed')
      return { ok: false, error: `Could not start recording into ${file}: ${err instanceof Error ? err.message : String(err)}` }
    }

    this.logRecorder = recorder
    this.resetIdleTimer()
    return { ok: true, data: formatRecorderStatus(recorder.status()) }
  }

  private async stopLogRecording(): Promise<ServerResponse> {
    if (!this.logRecorder) return { ok: true, data: 'Not recording' }
    const { file, lines } = this.logRecorder.status()
    this.logRecorder.stop('stop requested')
    this.logRecorder = null
    this.resetIdleTimer()
    return { ok: true, data: `Recording stopped — ${lines} lines in ${file}` }
  }

  private async clearLogFeed(file: string): Promise<ServerResponse> {
    this.consoleStream.clear()
    if (this.logRecorder?.file === file) {
      this.logRecorder.clearFeed()
      return { ok: true, data: `Feed cleared, recording continues — ${file}` }
    }
    if (!existsSync(file)) {
      return { ok: true, data: `Console buffer cleared. No feed file at ${file}.` }
    }
    writeFileSync(file, '')
    return { ok: true, data: `Feed cleared — ${file}` }
  }

  private async tailLogFeed(req: ServerRequest, file: string): Promise<ServerResponse> {
    if (!existsSync(file)) {
      return { ok: false, error: `No log feed at ${file}. Run \`agent-view logs start\` first.` }
    }

    const sinceToken = argStr(req.args, 'since')
    let since: string | undefined
    if (sinceToken !== undefined) {
      const parsed = parseSinceToken(sinceToken)
      if (parsed === null) {
        return { ok: false, error: `Invalid --since "${sinceToken}". Use -5m, 09:31, 09:31:02.500, or an ISO timestamp.` }
      }
      since = parsed
    }

    const { lines, scanTruncated } = readFeedLines(file)
    const selected = filterLogLines(lines, {
      grep: argStr(req.args, 'grep'),
      since,
      level: parseLevelFilter(argStrArray(req.args, 'levels')),
      limit: argNum(req.args, 'lines') ?? DEFAULT_TAIL_LINES,
    })

    if (selected.length === 0) {
      return { ok: true, data: lines.length === 0 ? '(feed is empty)' : '(no records match)' }
    }

    const { text, dropped } = capTailOutput(selected)
    const warnings = [
      dropped > 0 ? `Output cap hit — ${dropped} older matching records omitted.` : null,
      scanTruncated ? `Feed exceeds the scan window — older records are only in ${file}.` : null,
      // Without this, a static feed reads as "the app went quiet" instead of "nobody is recording".
      this.logRecorder?.file === file ? null : 'Not recording — this feed is static. Run `agent-view logs start`.',
    ].filter((w): w is string => w !== null)

    return { ok: true, data: text, warning: warnings.length > 0 ? warnings.join(' ') : undefined }
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
    this.logRecorder?.stop('server shutdown')
    this.logRecorder = null
    await unlink(TOKEN_PATH).catch(() => {})

    this.consoleStream.detach()
    this.networkStream.detach()
    for (const cached of this.connections.values()) {
      try { await cached.session.close() } catch { /* ignore */ }
    }
    this.connections.clear()

    this.server?.close()
    process.exit(0)
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

export type TargetMatch =
  | { kind: 'found'; target: TargetInfo }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: TargetInfo[] }

const MIN_ID_PREFIX_LENGTH = 4

/**
 * Resolve a `--target` query: exact id → id prefix → title/url substring.
 * The id-prefix step is load-bearing: `targets` prints ids truncated to 8 chars,
 * and that printed handle must be accepted back (workers have no title/url to
 * match on).
 */
export function matchTarget(targets: TargetInfo[], query: string): TargetMatch {
  const byId = targets.find(t => t.id === query)
  if (byId) return { kind: 'found', target: byId }

  const q = query.toLowerCase()

  if (q.length >= MIN_ID_PREFIX_LENGTH) {
    const byPrefix = targets.filter(t => t.id.toLowerCase().startsWith(q))
    if (byPrefix.length === 1) return { kind: 'found', target: byPrefix[0] }
    if (byPrefix.length > 1) return { kind: 'ambiguous', matches: byPrefix }
  }

  const bySubstring = targets.find(
    t => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q),
  )
  return bySubstring ? { kind: 'found', target: bySubstring } : { kind: 'none' }
}

export function describeTargetMatchFailure(query: string, match: TargetMatch): string {
  if (match.kind === 'ambiguous') {
    const list = match.matches.map(t => `${t.id} (${t.type})`).join(', ')
    return `Target id prefix "${query}" is ambiguous — matches: ${list}. Pass more characters.`
  }
  return `Target not found: "${query}". Run \`agent-view targets\` for the full list.`
}

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

function parseMethodFilter(methods: string[] | undefined): ReadonlySet<string> | undefined {
  if (!methods || methods.length === 0) return undefined
  const set = new Set(methods.map(m => m.trim().toUpperCase()).filter(Boolean))
  return set.size > 0 ? set : undefined
}

function parseTypeFilter(types: string[] | undefined): ReadonlySet<NetworkResourceType> | undefined {
  if (!types || types.length === 0) return undefined
  const valid = Object.values(NetworkResourceType) as string[]
  const set = new Set<NetworkResourceType>()
  for (const t of types) {
    const lower = t.trim().toLowerCase()
    if (valid.includes(lower)) set.add(lower as NetworkResourceType)
  }
  return set.size > 0 ? set : undefined
}

function parseStatusFilter(tokens: string[] | undefined): { statusClasses?: ReadonlySet<number>; statusCodes?: ReadonlySet<number>; includeFailed?: boolean } {
  if (!tokens || tokens.length === 0) return {}
  const classes = new Set<number>()
  const codes = new Set<number>()
  let includeFailed = false
  for (const tok of tokens) {
    const t = tok.trim().toLowerCase()
    if (t === 'failed' || t === 'fail') {
      includeFailed = true
      continue
    }
    const classMatch = /^([1-5])xx$/.exec(t)
    if (classMatch) {
      classes.add(Number(classMatch[1]))
      continue
    }
    const n = Number(t)
    if (Number.isInteger(n) && n >= 100 && n <= 599) codes.add(n)
  }
  return {
    statusClasses: classes.size > 0 ? classes : undefined,
    statusCodes: codes.size > 0 ? codes : undefined,
    includeFailed: includeFailed ? true : undefined,
  }
}

/** Response cap for `logs tail` — a feed can be megabytes; an agent's context cannot. */
const TAIL_OUTPUT_CAP = 200_000

function capTailOutput(lines: string[]): { text: string; dropped: number } {
  let total = 0
  let start = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1
    if (total > TAIL_OUTPUT_CAP) break
    start = i
  }
  const kept = start === lines.length ? lines.slice(-1) : lines.slice(start)
  return { text: kept.join('\n'), dropped: lines.length - kept.length }
}

function parseProbes(args: Record<string, unknown>): ProbeSpec[] {
  const raw = args['probes']
  if (!Array.isArray(raw)) return []
  const probes: ProbeSpec[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.name !== 'string' || typeof e.source !== 'string') continue
    probes.push({
      name: e.name,
      source: e.source,
      targetQuery: typeof e.targetQuery === 'string' ? e.targetQuery : undefined,
    })
  }
  return probes
}

function formatRecorderStatus(s: RecorderStatus): string {
  const out = [
    `recording  ${s.file}`,
    `started    ${localStamp(s.startedAt)} (${formatElapsed(Date.now() - s.startedAt)} ago)`,
    `feed       ${s.lines} lines, ${formatBytes(s.bytes)}${s.rotations > 0 ? `, rotated ${s.rotations}x` : ''}`,
    `targets    ${s.attached.length > 0 ? s.attached.join(', ') : '(none attached yet)'}`,
    `filters    levels=${s.levels?.join(',') ?? 'all'} target=${s.targetId ? s.targetId.slice(0, 8) : 'all'}`,
    `rescan     ${s.rescanMs}ms, ${s.ticks} ticks, last ${s.lastTickAt === null ? 'never' : localStamp(s.lastTickAt)}`,
  ]
  if (s.probes.length > 0) {
    out.push(`probes     ${s.probes.map(p => `${p.name}${p.targetQuery ? `@${p.targetQuery}` : ''} x${p.injections}`).join(', ')}`)
  }
  if (s.lastError) out.push(`last error ${s.lastError}`)
  return out.join('\n')
}

function formatIdleFeed(file: string): string {
  if (!existsSync(file)) {
    return `not recording\nfeed       ${file} (does not exist)\nstart with \`agent-view logs start\``
  }
  const stats = statSync(file)
  return [
    'not recording',
    `feed       ${file}`,
    `size       ${formatBytes(stats.size)}, last write ${localStamp(stats.mtimeMs)}`,
    'start with `agent-view logs start` — `logs tail` still reads the existing feed',
  ].join('\n')
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
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
