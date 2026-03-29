import { createServer, type Server, type Socket } from 'node:net'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAdapter } from '../adapters/registry.js'
import { formatAccessibilityTree } from '../inspectors/dom.js'
import { getSceneGraph, diffScenes, type SceneNode } from '../inspectors/scene.js'
import { RefStore } from './ref-store.js'
import { launch, isRunning } from './launcher.js'
import type { ServerRequest, ServerResponse, WindowInfo } from '../types.js'
import type { CDPConnection } from '../cdp/types.js'

const SERVER_PORT = 47922
const IDLE_TIMEOUT_MS = 5 * 60 * 1000
const DELIMITER = '\n'

export class AgentViewServer {
  private server: Server | null = null
  private connections = new Map<string, CDPConnection>()
  private refStore = new RefStore()
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private sceneCache = new Map<string, SceneNode>()

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
      conn = await adapter.connect(req.port, targetId)
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
    const launchCmd = req.args.launch as string
    if (!launchCmd) {
      return { ok: false, error: 'No launch command provided' }
    }

    if (await isRunning(req.port)) {
      return { ok: true, data: 'Application already running' }
    }

    await launch(launchCmd, req.port)
    return { ok: true, data: 'Application launched and ready' }
  }

  private async handleDom(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getConnection(req, targetId)

    const nodes = await conn.getAccessibilityTree()
    const { text, refs, nextRef } = formatAccessibilityTree(nodes, {
      filter: req.args.filter as string | undefined,
      depth: req.args.depth as number | undefined,
      startRef: this.refStore.getNextRef(),
    })

    this.refStore.store(refs, req.port, targetId, nextRef)

    return { ok: true, data: text }
  }

  private async handleClick(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getConnection(req, targetId)

    if (req.args.pos) {
      const { x, y } = req.args.pos as { x: number; y: number }
      await conn.clickAtPosition(x, y)
      return { ok: true, data: `Clicked at (${x}, ${y})` }
    }

    const ref = req.args.ref as number
    const entry = this.refStore.get(ref)
    if (!entry) {
      return { ok: false, error: `Invalid ref: ${ref}. Run \`agent-view dom\` to get fresh refs.` }
    }

    await conn.clickByNodeId(entry.backendDOMNodeId)
    return { ok: true, data: `Clicked ref ${ref}` }
  }

  private async handleFill(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getConnection(req, targetId)

    const ref = req.args.ref as number
    const value = req.args.value as string
    const entry = this.refStore.get(ref)
    if (!entry) {
      return { ok: false, error: `Invalid ref: ${ref}. Run \`agent-view dom\` to get fresh refs.` }
    }

    await conn.fillByNodeId(entry.backendDOMNodeId, value)
    return { ok: true, data: `Filled ref ${ref} with "${value}"` }
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

    const isDiff = req.args.diff as boolean
    const cacheKey = `${req.port}:${targetId}`

    if (isDiff) {
      // Get raw scene for diff comparison
      const EXTRACT_JS = `
(function() {
  const devtools = window.__PIXI_DEVTOOLS__;
  if (!devtools) return null;
  const app = devtools.app || devtools.stage?.parent;
  if (!app) return null;
  const stage = app.stage || devtools.stage;
  if (!stage) return null;
  function serialize(node) {
    const result = {
      type: node.constructor?.name || 'Unknown',
      name: node.label || node.name || '',
      x: Math.round(node.x || 0),
      y: Math.round(node.y || 0),
      visible: node.visible !== false,
      tint: typeof node.tint === 'number' ? '#' + node.tint.toString(16).padStart(6, '0') : '0xffffff',
      alpha: node.alpha ?? 1,
      children: (node.children || []).map(c => serialize(c)),
    };
    return result;
  }
  return serialize(stage);
})()
`
      const curr = await conn.evaluate(EXTRACT_JS) as SceneNode | null
      if (!curr) {
        return { ok: true, data: 'No PixiJS scene found. Ensure @pixi/devtools is initialized.' }
      }

      const prev = this.sceneCache.get(cacheKey)
      this.sceneCache.set(cacheKey, curr)

      if (!prev) {
        // First call — return full scene
        const text = await getSceneGraph(conn, {
          filter: req.args.filter as string | undefined,
          depth: req.args.depth as number | undefined,
          verbose: req.args.verbose as boolean | undefined,
        })
        return { ok: true, data: text }
      }

      const diffText = diffScenes(prev, curr)
      return { ok: true, data: diffText }
    }

    const text = await getSceneGraph(conn, {
      filter: req.args.filter as string | undefined,
      depth: req.args.depth as number | undefined,
      verbose: req.args.verbose as boolean | undefined,
    })

    return { ok: true, data: text }
  }

  private async handleSnap(req: ServerRequest): Promise<ServerResponse> {
    const { targetId } = await this.resolveWindow(req)
    const conn = await this.getConnection(req, targetId)

    // DOM section
    const nodes = await conn.getAccessibilityTree()
    const { text: domText, refs, nextRef } = formatAccessibilityTree(nodes, {
      filter: req.args.filter as string | undefined,
      depth: req.args.depth as number | undefined,
      startRef: this.refStore.getNextRef(),
    })
    this.refStore.store(refs, req.port, targetId, nextRef)

    // Scene section
    const sceneText = await getSceneGraph(conn, {
      filter: req.args.filter as string | undefined,
      depth: req.args.depth as number | undefined,
    })

    const sections = [`=== DOM ===\n${domText}`]
    if (!sceneText.startsWith('No PixiJS')) {
      sections.push(`=== Scene ===\n${sceneText}`)
    }

    return { ok: true, data: sections.join('\n\n') }
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
