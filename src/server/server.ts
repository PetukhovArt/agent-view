import { createServer, type Server, type Socket } from 'node:net'
import { getAdapter } from '../adapters/registry.js'
import { formatAccessibilityTree } from '../inspectors/dom.js'
import { RefStore } from './ref-store.js'
import type { ServerRequest, ServerResponse } from '../types.js'
import type { CDPConnection } from '../cdp/types.js'

const SERVER_PORT = 47922
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DELIMITER = '\n'

export class AgentViewServer {
  private server: Server | null = null
  private connections = new Map<string, CDPConnection>()
  private refStore = new RefStore()
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  async start(): Promise<void> {
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
      case 'dom':
        return this.handleDom(req)
      case 'stop':
        return this.handleStop()
      default:
        return { ok: false, error: `Unknown command: ${req.command}` }
    }
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

  private async handleDom(req: ServerRequest): Promise<ServerResponse> {
    const adapter = getAdapter(req.runtime)
    const windowArg = (req.args.window as string) || undefined

    // Resolve target: by ID first, then by title match
    let targetId: string | undefined
    const windows = await adapter.discover(req.port)
    if (windows.length === 0) {
      return { ok: false, error: 'No windows found. Is the application running?' }
    }

    if (windowArg) {
      const byId = windows.find(w => w.id === windowArg)
      const byTitle = windows.find(w => w.title.toLowerCase().includes(windowArg.toLowerCase()))
      targetId = byId?.id ?? byTitle?.id
      if (!targetId) {
        return { ok: false, error: `Window not found: "${windowArg}". Available: ${windows.map(w => `"${w.title}" (${w.id})`).join(', ')}` }
      }
    } else {
      targetId = windows[0].id
    }

    // Get or create connection
    const connKey = `${req.port}:${targetId}`
    let conn = this.connections.get(connKey)
    if (!conn) {
      conn = await adapter.connect(req.port, targetId)
      this.connections.set(connKey, conn)
    }

    const nodes = await conn.getAccessibilityTree()
    const { text, refs, nextRef } = formatAccessibilityTree(nodes, {
      filter: req.args.filter as string | undefined,
      depth: req.args.depth as number | undefined,
      startRef: this.refStore.getNextRef(),
    })

    this.refStore.store(refs, req.port, targetId, nextRef)

    return { ok: true, data: text }
  }

  private async handleStop(): Promise<ServerResponse> {
    setTimeout(() => this.shutdown(), 100)
    return { ok: true, data: 'Server stopping' }
  }

  private async shutdown(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer)

    for (const conn of this.connections.values()) {
      try { await conn.close() } catch { /* ignore */ }
    }
    this.connections.clear()

    this.server?.close()
    process.exit(0)
  }
}
