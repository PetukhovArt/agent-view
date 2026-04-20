import { createServer, type Server, type Socket } from 'node:net'
import { writeFile, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { getAdapter } from '../adapters/registry.js'
import { formatAccessibilityTree } from '../inspectors/dom.js'
import { getSceneGraph, getRawScene, diffScenes, type SceneNode } from '../inspectors/scene/index.js'
import { RefStore } from './ref-store.js'
import { launch, isRunning } from './launcher.js'
import { readConfig } from '../config/manager.js'
import { RuntimeType, WebGLEngine, type ServerRequest, type ServerResponse, type WindowInfo } from '../types.js'
import type { CDPConnection } from '../cdp/types.js'
import { AxTreeCache } from '../cdp/ax-cache.js'

const SERVER_PORT = 47922
const VALID_COMMANDS = new Set(['discover', 'launch', 'dom', 'click', 'fill', 'screenshot', 'scene', 'snap', 'wait', 'stop'])
const VALID_RUNTIMES = new Set<RuntimeType>(Object.values(RuntimeType))
const VALID_ENGINES = new Set<WebGLEngine>(Object.values(WebGLEngine))
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DELIMITER = '\n'
const MAX_BUFFER_SIZE = 1_048_576 // 1 MB
const TOKEN_DIR = join(homedir(), '.agent-view')
const TOKEN_PATH = join(TOKEN_DIR, 'token')

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

export class AgentViewServer {
  private server: Server | null = null
  private connections = new Map<string, CDPConnection>()
  private refStore = new RefStore()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private sceneCache = new Map<string, SceneNode>()
  private axTreeCache = new AxTreeCache()
  private token = ''

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
        typeof request.command !== 'string' || !VALID_COMMANDS.has(request.command) ||
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
    switch (req.command) {
      case 'discover':
        return this.handleDiscover(req)
      case 'launch':
        return this.handleLaunch(req)
      case 'dom':
        return this.handleDom(req)
      case 'click':
        return this.handleClick(req)
      case 'fill':
        return this.handleFill(req)
      case 'screenshot':
        return this.handleScreenshot(req)
      case 'scene':
        return this.handleScene(req)
      case 'snap':
        return this.handleSnap(req)
      case 'wait':
        return this.handleWait(req)
      case 'stop':
        return this.handleStop()
      default:
        return { ok: false, error: `Unknown command: ${req.command}` }
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

  private async getConnection(req: ServerRequest, targetId: string): Promise<CDPConnection> {
    const connKey = `${req.port}:${targetId}`
    let conn = this.connections.get(connKey)
    if (!conn) {
      const adapter = getAdapter(req.runtime)
      conn = await adapter.connect(req.port, targetId, this.axTreeCache)
      this.connections.set(connKey, conn)
    }
    return conn
  }

  private async handleDiscover(req: ServerRequest): Promise<ServerResponse> {
    const adapter = getAdapter(req.runtime)
    const windows = await adapter.discover(req.port)
    return {
      ok: true,
      data: {
        runtime: req.runtime,
        port: req.port,
        windows,
      },
    }
  }

  private async handleLaunch(req: ServerRequest): Promise<ServerResponse> {
    const launchCmd = argStr(req.args, 'launch')
    const cwd = argStr(req.args, 'cwd')
    if (!launchCmd) {
      return { ok: false, error: 'No launch command provided' }
    }
    if (!cwd) {
      return { ok: false, error: 'launch requires cwd to validate config' }
    }

    // Validate launch command against on-disk config to prevent injection
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
    const conn = await this.getConnection(req, targetId)

    const nodes = await conn.getAccessibilityTree()
    const { text, refs, nextRef } = formatAccessibilityTree(nodes, {
      filter: argStr(req.args, 'filter'),
      depth: argNum(req.args, 'depth'),
      startRef: this.refStore.getNextRef(),
    })

    this.refStore.store(refs, req.port, targetId, nextRef)

    return { ok: true, data: text }
  }

  private async findByFilter(
    conn: CDPConnection,
    filter: string,
    req: ServerRequest,
    targetId: string,
    preferRoles?: Set<string>,
  ): Promise<{ backendDOMNodeId: number; name: string } | null> {
    const nodes = await conn.getAccessibilityTree()
    const { refs, nextRef } = formatAccessibilityTree(nodes, {
      filter,
      startRef: this.refStore.getNextRef(),
    })

    this.refStore.store(refs, req.port, targetId, nextRef)

    if (refs.length === 0) return null

    // Build map with fallback name resolution (same logic as dom.ts)
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

    // If preferred roles specified, try those first
    if (preferRoles) {
      for (const entry of refs) {
        const info = nodeByDOMId.get(entry.backendDOMNodeId)
        if (info && preferRoles.has(info.role) && info.name.toLowerCase().includes(lowerFilter)) {
          return { backendDOMNodeId: entry.backendDOMNodeId, name: info.name }
        }
      }
    }

    // Pick the deepest match whose name contains the filter text (leaf-first)
    for (let i = refs.length - 1; i >= 0; i--) {
      const info = nodeByDOMId.get(refs[i].backendDOMNodeId)
      if (info && info.name.toLowerCase().includes(lowerFilter)) {
        return { backendDOMNodeId: refs[i].backendDOMNodeId, name: info.name }
      }
    }

    // Fallback: last ref (deepest element in filtered tree)
    const last = refs[refs.length - 1]
    const lastInfo = nodeByDOMId.get(last.backendDOMNodeId)
    return { backendDOMNodeId: last.backendDOMNodeId, name: lastInfo?.name ?? filter }
  }

  private async handleClick(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getConnection(req, targetId)
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

  private async handleFill(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getConnection(req, targetId)
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
    const conn = await this.getConnection(req, targetId)

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
    const conn = await this.getConnection(req, targetId)

    const buffer = await conn.captureScreenshot()
    const filename = `agent-view-screenshot-${Date.now()}.png`
    const filepath = join(tmpdir(), filename)
    await writeFile(filepath, buffer)

    return { ok: true, data: filepath }
  }

  private async handleScene(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getConnection(req, targetId)

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
    const conn = await this.getConnection(req, targetId)

    const snapFilter = argStr(req.args, 'filter')
    const snapDepth = argNum(req.args, 'depth')

    // DOM section
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

  private async handleStop(): Promise<ServerResponse> {
    setTimeout(() => this.shutdown(), 100)
    return { ok: true, data: 'Server stopping' }
  }

  private async shutdown(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)

    await unlink(TOKEN_PATH).catch(() => {})

    for (const conn of this.connections.values()) {
      try { await conn.close() } catch { /* ignore */ }
    }
    this.connections.clear()

    this.server?.close()
    process.exit(0)
  }
}
