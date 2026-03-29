# Iteration 1: Core (init, discover, dom, stop)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the foundational CLI that connects to a running Electron/Browser app via CDP and returns a compact DOM accessibility tree.

**Architecture:** CLI (`commander`) reads config from `agent-view.config.json`, sends JSON commands over TCP to a lazy background server. The server manages CDP connections via `chrome-remote-interface`, retrieves accessibility trees, and formats them as compact LLM-friendly text. Server auto-starts on first CLI call, auto-shuts down after 5 min idle.

**Tech Stack:** TypeScript, Node.js, pnpm, `commander` (CLI), `chrome-remote-interface` (CDP), TCP (IPC)

**Test project:** `D:\web-projects\web-client` (Electron + Vue 3, `npm run dev`, needs `--remote-debugging-port=9222` in main process)

---

## File Structure

```
agent-view/
  package.json
  tsconfig.json
  src/
    types.ts                    # Shared types (Config, Window, RuntimeInfo)
    config/
      types.ts                  # Config type definition
      manager.ts                # readConfig, generateConfig, writeConfig
    cdp/
      types.ts                  # Transport interface, Connection type
      transport.ts              # CDP connection via chrome-remote-interface
    adapters/
      types.ts                  # RuntimeAdapter interface
      electron.ts               # Electron-specific discovery and target filtering
      browser.ts                # Browser adapter (Chrome/Edge)
      tauri.ts                  # Tauri adapter (stub for iteration 3)
    inspectors/
      dom.ts                    # DOM Inspector: AX tree → compact text with refs
    server/
      index.ts                  # Server entry point (spawned as child process)
      server.ts                 # TCP server: handles JSON commands, manages CDP connections
      ref-store.ts              # Session ref ID ↔ backendNodeId mapping
    cli/
      index.ts                  # CLI entry point (commander setup, lazy server spawn)
      client.ts                 # TCP client: sends command to server, reads response
      commands/
        init.ts                 # agent-view init
        discover.ts             # agent-view discover
        dom.ts                  # agent-view dom
        stop.ts                 # agent-view stop
```

---

## Parallel Slice Map

```
Slice 1 (foundation):     Task 1 scaffolding
                              ↓
Slice 2 (parallel):       Task 2 config  ║  Task 3 cdp+adapters
                              ↓                    ↓
Slice 3 (parallel):       Task 4 dom-inspector  ║  Task 5 lazy-server
                              ↓                    ↓
Slice 4 (sequential):     Task 6 cli + commands wiring
                              ↓
Slice 5 (manual):         Task 7 integration on web-client
```

Tasks within the same slice are independent and can run as parallel subagents.

---

## Task 1: Project Scaffolding

**Slice:** 1 (foundation — must run first)

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`

- [ ] **Step 1: Initialize pnpm project**

```bash
cd D:/web-projects/agent-view
pnpm init
```

- [ ] **Step 2: Install dependencies**

```bash
pnpm add commander chrome-remote-interface
pnpm add -D typescript @types/node tsx
```

`tsx` for running TS directly during dev. `commander` for CLI parsing. `chrome-remote-interface` for CDP.

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 4: Create src/types.ts with shared types**

```typescript
export type RuntimeType = 'electron' | 'tauri' | 'browser'

export type WebGLEngine = 'pixi' | 'cesium' | 'three'

export type WindowInfo = {
  id: string
  title: string
  url: string
  type: string
}

export type RuntimeInfo = {
  runtime: RuntimeType
  port: number
  windows: WindowInfo[]
}

export type ServerRequest = {
  command: string
  port: number
  runtime: RuntimeType
  args: Record<string, unknown>
}

export type ServerResponse = {
  ok: boolean
  data?: unknown
  error?: string
}
```

- [ ] **Step 5: Add bin and scripts to package.json**

Add to `package.json`:
```json
{
  "type": "module",
  "bin": {
    "agent-view": "./dist/cli/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli/index.ts"
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json src/types.ts
git commit -m "chore: scaffold project with dependencies and shared types"
```

---

## Task 2: Config Manager

**Slice:** 2A (parallel with Task 3)
**Depends on:** Task 1

**Files:**
- Create: `src/config/types.ts`
- Create: `src/config/manager.ts`

- [ ] **Step 1: Create config types**

`src/config/types.ts`:
```typescript
import type { RuntimeType, WebGLEngine } from '../types.js'

export type AgentViewConfig = {
  runtime: RuntimeType
  port: number
  launch: string
  webgl?: {
    engine: WebGLEngine
  }
  verify?: Record<string, { steps: string[] }>
}
```

- [ ] **Step 2: Create config manager**

`src/config/manager.ts` with three functions:

- `readConfig(cwd: string): AgentViewConfig | null` — reads `agent-view.config.json` from given dir, returns null if not found
- `generateConfig(cwd: string): AgentViewConfig` — reads `package.json` from cwd, detects runtime by dependencies (`electron` → electron, `@tauri-apps/api` → tauri, else browser), detects WebGL engine (`pixi.js` → pixi, `cesium` → cesium, `three` → three), detects launch command from scripts (`dev` script), sets default port 9222
- `writeConfig(cwd: string, config: AgentViewConfig): void` — writes `agent-view.config.json`

Detection logic:
```typescript
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentViewConfig } from './types.js'
import type { RuntimeType, WebGLEngine } from '../types.js'

const CONFIG_FILENAME = 'agent-view.config.json'

export function readConfig(cwd: string): AgentViewConfig | null {
  const configPath = join(cwd, CONFIG_FILENAME)
  if (!existsSync(configPath)) return null
  const raw = readFileSync(configPath, 'utf-8')
  return JSON.parse(raw) as AgentViewConfig
}

export function generateConfig(cwd: string): AgentViewConfig {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new Error(`package.json not found in ${cwd}`)
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

  const runtime = detectRuntime(allDeps)
  const webglEngine = detectWebGL(allDeps)
  const launch = detectLaunchCommand(cwd, pkg.scripts)

  const config: AgentViewConfig = {
    runtime,
    port: 9222,
    launch,
  }

  if (webglEngine) {
    config.webgl = { engine: webglEngine }
  }

  return config
}

export function writeConfig(cwd: string, config: AgentViewConfig): void {
  const configPath = join(cwd, CONFIG_FILENAME)
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

function detectRuntime(deps: Record<string, string>): RuntimeType {
  if (deps['electron'] || deps['electron-vite']) return 'electron'
  if (deps['@tauri-apps/api'] || deps['@tauri-apps/cli']) return 'tauri'
  return 'browser'
}

function detectWebGL(deps: Record<string, string>): WebGLEngine | undefined {
  if (deps['pixi.js'] || deps['@pixi/app']) return 'pixi'
  if (deps['cesium']) return 'cesium'
  if (deps['three']) return 'three'
  return undefined
}

function detectLaunchCommand(cwd: string, scripts?: Record<string, string>): string {
  const pm = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'
  if (!scripts) return `${pm} run dev`
  if (scripts['dev']) return `${pm} run dev`
  if (scripts['start']) return `${pm} start`
  return `${pm} run dev`
}
```

- [ ] **Step 3: Commit**

```bash
git add src/config/
git commit -m "feat: config manager with auto-detection from package.json"
```

---

## Task 3: CDP Transport + Runtime Adapters

**Slice:** 2B (parallel with Task 2)
**Depends on:** Task 1

**Files:**
- Create: `src/cdp/types.ts`
- Create: `src/cdp/transport.ts`
- Create: `src/adapters/types.ts`
- Create: `src/adapters/electron.ts`
- Create: `src/adapters/browser.ts`
- Create: `src/adapters/tauri.ts`

- [ ] **Step 1: Create CDP types**

`src/cdp/types.ts`:
```typescript
import type { WindowInfo } from '../types.js'

export type CDPTarget = {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl: string
}

export type CDPConnection = {
  evaluate: (expression: string) => Promise<unknown>
  getAccessibilityTree: () => Promise<AXNode[]>
  captureScreenshot: () => Promise<Buffer>
  close: () => Promise<void>
}

export type AXNode = {
  nodeId: string
  role: { value: string }
  name?: { value: string }
  childIds?: string[]
  backendDOMNodeId?: number
  properties?: AXProperty[]
}

export type AXProperty = {
  name: string
  value: { type: string; value?: unknown }
}
```

- [ ] **Step 2: Create CDP transport**

`src/cdp/transport.ts` — wraps `chrome-remote-interface`:

```typescript
import CDP from 'chrome-remote-interface'
import type { CDPConnection, CDPTarget, AXNode } from './types.js'

export async function listTargets(port: number): Promise<CDPTarget[]> {
  try {
    const targets = await CDP.List({ port })
    return targets as CDPTarget[]
  } catch {
    return []
  }
}

export async function connectToTarget(port: number, targetId: string): Promise<CDPConnection> {
  const client = await CDP({ port, target: targetId })
  const { Runtime, Accessibility, Page } = client

  await Page.enable()
  await Accessibility.enable()

  return {
    async evaluate(expression: string): Promise<unknown> {
      const { result } = await Runtime.evaluate({
        expression,
        returnByValue: true,
      })
      return result.value
    },

    async getAccessibilityTree(): Promise<AXNode[]> {
      const { nodes } = await Accessibility.getFullAXTree()
      return nodes as AXNode[]
    },

    async captureScreenshot(): Promise<Buffer> {
      const { data } = await Page.captureScreenshot({ format: 'png' })
      return Buffer.from(data, 'base64')
    },

    async close(): Promise<void> {
      await client.close()
    },
  }
}
```

- [ ] **Step 3: Create adapter interface**

`src/adapters/types.ts`:
```typescript
import type { WindowInfo, RuntimeType } from '../types.js'
import type { CDPConnection } from '../cdp/types.js'

export type RuntimeAdapter = {
  readonly runtime: RuntimeType
  discover(port: number): Promise<WindowInfo[]>
  connect(port: number, windowId: string): Promise<CDPConnection>
}
```

- [ ] **Step 4: Create Electron adapter**

`src/adapters/electron.ts`:

```typescript
import { listTargets, connectToTarget } from '../cdp/transport.js'
import type { RuntimeAdapter } from './types.js'
import type { WindowInfo } from '../types.js'
import type { CDPConnection } from '../cdp/types.js'

export const electronAdapter: RuntimeAdapter = {
  runtime: 'electron',

  async discover(port: number): Promise<WindowInfo[]> {
    const targets = await listTargets(port)
    return targets
      .filter(t => t.type === 'page')
      .map(t => ({
        id: t.id,
        title: t.title,
        url: t.url,
        type: t.type,
      }))
  },

  async connect(port: number, windowId: string): Promise<CDPConnection> {
    return connectToTarget(port, windowId)
  },
}
```

- [ ] **Step 5: Create Browser adapter**

`src/adapters/browser.ts` — same structure as electron, filter pages:

```typescript
import { listTargets, connectToTarget } from '../cdp/transport.js'
import type { RuntimeAdapter } from './types.js'
import type { WindowInfo } from '../types.js'
import type { CDPConnection } from '../cdp/types.js'

export const browserAdapter: RuntimeAdapter = {
  runtime: 'browser',

  async discover(port: number): Promise<WindowInfo[]> {
    const targets = await listTargets(port)
    return targets
      .filter(t => t.type === 'page')
      .map(t => ({
        id: t.id,
        title: t.title,
        url: t.url,
        type: t.type,
      }))
  },

  async connect(port: number, windowId: string): Promise<CDPConnection> {
    return connectToTarget(port, windowId)
  },
}
```

- [ ] **Step 6: Create Tauri adapter (stub)**

`src/adapters/tauri.ts`:

```typescript
import { listTargets, connectToTarget } from '../cdp/transport.js'
import type { RuntimeAdapter } from './types.js'
import type { WindowInfo } from '../types.js'
import type { CDPConnection } from '../cdp/types.js'

export const tauriAdapter: RuntimeAdapter = {
  runtime: 'tauri',

  async discover(port: number): Promise<WindowInfo[]> {
    // Tauri/WebView2 on Windows exposes CDP same as Chromium
    const targets = await listTargets(port)
    return targets
      .filter(t => t.type === 'page')
      .map(t => ({
        id: t.id,
        title: t.title,
        url: t.url,
        type: t.type,
      }))
  },

  async connect(port: number, windowId: string): Promise<CDPConnection> {
    return connectToTarget(port, windowId)
  },
}
```

- [ ] **Step 7: Create adapter registry**

Add to `src/adapters/types.ts` at the bottom:

```typescript
import { electronAdapter } from './electron.js'
import { browserAdapter } from './browser.js'
import { tauriAdapter } from './tauri.js'

const adapters: Record<RuntimeType, RuntimeAdapter> = {
  electron: electronAdapter,
  browser: browserAdapter,
  tauri: tauriAdapter,
}

export function getAdapter(runtime: RuntimeType): RuntimeAdapter {
  return adapters[runtime]
}
```

Wait — this creates a circular import. Instead, create a separate registry file.

Create `src/adapters/registry.ts`:
```typescript
import type { RuntimeType } from '../types.js'
import type { RuntimeAdapter } from './types.js'
import { electronAdapter } from './electron.js'
import { browserAdapter } from './browser.js'
import { tauriAdapter } from './tauri.js'

const adapters: Record<RuntimeType, RuntimeAdapter> = {
  electron: electronAdapter,
  browser: browserAdapter,
  tauri: tauriAdapter,
}

export function getAdapter(runtime: RuntimeType): RuntimeAdapter {
  return adapters[runtime]
}
```

- [ ] **Step 8: Commit**

```bash
git add src/cdp/ src/adapters/
git commit -m "feat: CDP transport and runtime adapters (electron, browser, tauri stub)"
```

---

## Task 4: DOM Inspector

**Slice:** 3A (parallel with Task 5)
**Depends on:** Task 3 (uses CDPConnection, AXNode types)

**Files:**
- Create: `src/inspectors/dom.ts`

- [ ] **Step 1: Create DOM Inspector**

`src/inspectors/dom.ts` — transforms raw AX tree into compact LLM-friendly text.

Key design:
- Each node: `role "name" [ref=N]` with indentation for depth
- Session ref IDs: incremental integer, counter persists in server (not reset per call)
- `formatAccessibilityTree` receives `startRef` from server, returns `nextRef` so server tracks the counter
- Filter: case-insensitive match on name
- Depth: limit tree traversal depth
- Skip ignored/redundant nodes (role: "none", "generic" without name)

```typescript
import type { AXNode } from '../cdp/types.js'

export type RefEntry = {
  ref: number
  backendDOMNodeId: number
}

export type DOMSnapshotOptions = {
  filter?: string
  depth?: number
  startRef?: number
}

export type DOMSnapshotResult = {
  text: string
  refs: RefEntry[]
  nextRef: number
}

export function formatAccessibilityTree(
  nodes: AXNode[],
  options: DOMSnapshotOptions = {},
): DOMSnapshotResult {
  const { filter, depth: maxDepth } = options
  const refs: RefEntry[] = []
  let nextRef = options.startRef ?? 1
  const lines: string[] = []

  // Build nodeId → node map from flat array
  const nodeMap = new Map<string, AXNode>()
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node)
  }

  const rootNodeId = nodes[0]?.nodeId
  if (!rootNodeId) return { text: '(empty)', refs: [], nextRef }

  const SKIP_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'StaticText'])

  function walk(nodeId: string, depth: number, indent: number): void {
    if (maxDepth !== undefined && indent > maxDepth) return

    const node = nodeMap.get(nodeId)
    if (!node) return

    const role = node.role?.value ?? ''
    const name = node.name?.value ?? ''

    const skip = SKIP_ROLES.has(role) && !name

    if (!skip) {
      if (filter) {
        const lowerFilter = filter.toLowerCase()
        const matchesName = name.toLowerCase().includes(lowerFilter)
        const matchesRole = role.toLowerCase().includes(lowerFilter)
        if (!matchesName && !matchesRole && !hasMatchingDescendant(node, lowerFilter)) {
          return
        }
      }

      const ref = nextRef++
      if (node.backendDOMNodeId) {
        refs.push({ ref, backendDOMNodeId: node.backendDOMNodeId })
      }

      const padding = '  '.repeat(indent)
      const nameStr = name ? ` "${name}"` : ''
      lines.push(`${padding}${role}${nameStr} [ref=${ref}]`)
    }

    if (node.childIds) {
      for (const childId of node.childIds) {
        walk(childId, depth + 1, skip ? indent : indent + 1)
      }
    }
  }

  function hasMatchingDescendant(node: AXNode, lowerFilter: string): boolean {
    if (!node.childIds) return false
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId)
      if (!child) continue
      const childName = child.name?.value?.toLowerCase() ?? ''
      const childRole = child.role?.value?.toLowerCase() ?? ''
      if (childName.includes(lowerFilter) || childRole.includes(lowerFilter)) return true
      if (hasMatchingDescendant(child, lowerFilter)) return true
    }
    return false
  }

  walk(rootNodeId, 0, 0)

  return {
    text: lines.join('\n') || '(no matching elements)',
    refs,
    nextRef,
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/inspectors/
git commit -m "feat: DOM inspector — AX tree to compact text with session refs"
```

---

## Task 5: Lazy Server

**Slice:** 3B (parallel with Task 4)
**Depends on:** Task 3 (uses adapters, CDP transport)

**Files:**
- Create: `src/server/ref-store.ts`
- Create: `src/server/server.ts`
- Create: `src/server/index.ts`

- [ ] **Step 1: Create ref store**

`src/server/ref-store.ts` — stores session ref → backendDOMNodeId mapping:

```typescript
type RefEntry = {
  ref: number
  backendDOMNodeId: number
  port: number
  windowId: string
}

export class RefStore {
  private entries = new Map<number, RefEntry>()
  private nextRef = 1

  getNextRef(): number {
    return this.nextRef
  }

  /** Clear old refs for this window, store new ones, update counter */
  store(refs: Array<{ ref: number; backendDOMNodeId: number }>, port: number, windowId: string, nextRef: number): void {
    // Clear previous refs for this window
    for (const [key, entry] of this.entries) {
      if (entry.port === port && entry.windowId === windowId) {
        this.entries.delete(key)
      }
    }
    // Store new refs
    for (const { ref, backendDOMNodeId } of refs) {
      this.entries.set(ref, { ref, backendDOMNodeId, port, windowId })
    }
    this.nextRef = nextRef
  }

  get(ref: number): RefEntry | undefined {
    return this.entries.get(ref)
  }

  clear(): void {
    this.entries.clear()
    this.nextRef = 1
  }
}
```

- [ ] **Step 2: Create server**

`src/server/server.ts` — TCP server handling JSON commands:

```typescript
import { createServer, type Server, type Socket } from 'node:net'
import { getAdapter } from '../adapters/registry.js'
import { formatAccessibilityTree } from '../inspectors/dom.js'
import { RefStore } from './ref-store.js'
import type { ServerRequest, ServerResponse, RuntimeType } from '../types.js'
import type { CDPConnection } from '../cdp/types.js'

const SERVER_PORT = 47922
const IDLE_TIMEOUT_MS = 5 * 60 * 1000

export class AgentViewServer {
  private server: Server | null = null
  private connections = new Map<string, CDPConnection>()
  private refStore = new RefStore()
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(socket => this.handleSocket(socket))
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
    let data = ''

    socket.on('data', chunk => {
      data += chunk.toString()
    })

    socket.on('end', async () => {
      try {
        const request = JSON.parse(data) as ServerRequest
        const response = await this.handleCommand(request)
        socket.end(JSON.stringify(response))
      } catch (err) {
        const response: ServerResponse = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
        socket.end(JSON.stringify(response))
      }
    })
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
```

- [ ] **Step 3: Create server entry point**

`src/server/index.ts`:

```typescript
import { AgentViewServer } from './server.js'

const server = new AgentViewServer()
server.start()
  .then(() => {
    // Server is running, write ready signal to stdout for CLI to detect
    process.stdout.write('READY\n')
  })
  .catch(err => {
    process.stderr.write(`Failed to start server: ${err}\n`)
    process.exit(1)
  })
```

- [ ] **Step 4: Commit**

```bash
git add src/server/
git commit -m "feat: lazy TCP server with CDP connection management and idle shutdown"
```

---

## Task 6: CLI + Commands Wiring

**Slice:** 4 (sequential — depends on Tasks 2, 4, 5)
**Depends on:** Tasks 2, 4, 5

**Files:**
- Create: `src/cli/client.ts`
- Create: `src/cli/index.ts`
- Create: `src/cli/commands/init.ts`
- Create: `src/cli/commands/discover.ts`
- Create: `src/cli/commands/dom.ts`
- Create: `src/cli/commands/stop.ts`

- [ ] **Step 1: Create TCP client**

`src/cli/client.ts` — sends request to lazy server, spawns server if not running:

```typescript
import { connect, type Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { ServerRequest, ServerResponse } from '../types.js'

const SERVER_PORT = 47922

export async function sendCommand(request: ServerRequest): Promise<ServerResponse> {
  try {
    return await tryConnect(request)
  } catch {
    // Server not running — start it
    await startServer()
    return tryConnect(request)
  }
}

function tryConnect(request: ServerRequest): Promise<ServerResponse> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(SERVER_PORT, '127.0.0.1')
    let data = ''

    socket.on('connect', () => {
      socket.end(JSON.stringify(request))
    })

    socket.on('data', chunk => {
      data += chunk.toString()
    })

    socket.on('end', () => {
      try {
        resolve(JSON.parse(data) as ServerResponse)
      } catch {
        reject(new Error('Invalid response from server'))
      }
    })

    socket.on('error', reject)
  })
}

async function startServer(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const serverEntryJs = join(__dirname, '..', 'server', 'index.js')
  const serverEntryTs = join(__dirname, '..', 'server', 'index.ts')

  // Detect dev (tsx) vs built (node) by checking if .ts source exists
  const isDev = existsSync(serverEntryTs) && !existsSync(serverEntryJs)
  const cmd = isDev ? 'npx' : 'node'
  const args = isDev ? ['tsx', serverEntryTs] : [serverEntryJs]

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: true,
  })
  child.unref()

  // Wait for READY signal
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Server startup timeout (10s)'))
    }, 10_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('READY')) {
        clearTimeout(timeout)
        resolve()
      }
    })

    child.on('error', err => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}
```

- [ ] **Step 2: Create init command**

`src/cli/commands/init.ts`:

```typescript
import { generateConfig, writeConfig, readConfig } from '../../config/manager.js'

export function runInit(cwd: string): void {
  const existing = readConfig(cwd)
  if (existing) {
    console.log('agent-view.config.json already exists:')
    console.log(JSON.stringify(existing, null, 2))
    return
  }

  const config = generateConfig(cwd)
  writeConfig(cwd, config)
  console.log('Generated agent-view.config.json:')
  console.log(JSON.stringify(config, null, 2))
}
```

- [ ] **Step 3: Create discover command**

`src/cli/commands/discover.ts`:

```typescript
import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

export async function runDiscover(config: AgentViewConfig): Promise<void> {
  const response = await sendCommand({
    command: 'discover',
    port: config.port,
    runtime: config.runtime,
    args: {},
  })

  if (!response.ok) {
    console.error(`Error: ${response.error}`)
    process.exit(1)
  }

  // discover is the only command that outputs JSON
  console.log(JSON.stringify(response.data, null, 2))
}
```

- [ ] **Step 4: Create dom command**

`src/cli/commands/dom.ts`:

```typescript
import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type DomOptions = {
  window?: string
  filter?: string
  depth?: number
}

export async function runDom(config: AgentViewConfig, options: DomOptions): Promise<void> {
  const response = await sendCommand({
    command: 'dom',
    port: config.port,
    runtime: config.runtime,
    args: {
      window: options.window,
      filter: options.filter,
      depth: options.depth,
    },
  })

  if (!response.ok) {
    console.error(`Error: ${response.error}`)
    process.exit(1)
  }

  // dom outputs plain text
  console.log(response.data)
}
```

- [ ] **Step 5: Create stop command**

`src/cli/commands/stop.ts`:

```typescript
import { sendCommand } from '../client.js'

export async function runStop(): Promise<void> {
  try {
    const response = await sendCommand({
      command: 'stop',
      port: 0,
      runtime: 'browser',
      args: {},
    })

    if (response.ok) {
      console.log('Server stopped')
    } else {
      console.error(`Error: ${response.error}`)
    }
  } catch {
    console.log('Server is not running')
  }
}
```

- [ ] **Step 6: Create CLI entry point**

`src/cli/index.ts`:

```typescript
#!/usr/bin/env node

import { Command } from 'commander'
import { readConfig } from '../config/manager.js'
import { runInit } from './commands/init.js'
import { runDiscover } from './commands/discover.js'
import { runDom } from './commands/dom.js'
import { runStop } from './commands/stop.js'
import type { AgentViewConfig } from '../config/types.js'

const program = new Command()
  .name('agent-view')
  .description('Visual verification CLI for desktop apps')
  .version('0.1.0')

program
  .command('init')
  .description('Auto-generate agent-view.config.json')
  .action(() => {
    runInit(process.cwd())
  })

program
  .command('discover')
  .description('Discover running application and its windows')
  .action(async () => {
    const config = requireConfig()
    await runDiscover(config)
  })

program
  .command('dom')
  .description('Get DOM accessibility tree')
  .option('-w, --window <id>', 'Target window ID or name')
  .option('-f, --filter <text>', 'Filter by text/name')
  .option('-d, --depth <n>', 'Max tree depth', parseInt)
  .action(async (options) => {
    const config = requireConfig()
    await runDom(config, options)
  })

program
  .command('stop')
  .description('Stop the lazy server')
  .action(async () => {
    await runStop()
  })

function requireConfig(): AgentViewConfig {
  const config = readConfig(process.cwd())
  if (!config) {
    console.error('No agent-view.config.json found. Run `agent-view init` first.')
    process.exit(1)
  }
  return config
}

program.parse()
```

- [ ] **Step 7: Verify build**

```bash
cd D:/web-projects/agent-view
pnpm build
```

Expected: clean compilation into `dist/`, no errors.

- [ ] **Step 8: Commit**

```bash
git add src/cli/
git commit -m "feat: CLI entry point with init, discover, dom, stop commands"
```

---

## Task 7: Integration Test on web-client

**Slice:** 5 (manual — depends on Task 6)
**Depends on:** Task 6

This is a manual verification task, not automated tests.

**Prerequisite:** Add `--remote-debugging-port=9222` to Electron launch in `D:\web-projects\web-client`.

- [ ] **Step 1: Verify Electron CDP flag exists in web-client**

Check `D:\web-projects\web-client` main process file for `remote-debugging-port`. If missing, add:
```typescript
if (process.env.NODE_ENV === 'development') {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}
```

Note: In `electron-vite`, the main process entry is typically at `src/main/index.ts` or `electron/main.ts`. Find the file that calls `app.whenReady()`.

- [ ] **Step 2: Start web-client**

```bash
cd D:\web-projects\web-client
npm run dev
```

- [ ] **Step 3: Test init from web-client directory**

```bash
cd D:\web-projects\web-client
npx tsx D:/web-projects/agent-view/src/cli/index.ts init
```

Expected: generates `agent-view.config.json` with `runtime: "electron"`, `port: 9222`, `launch: "npm run dev"`.

- [ ] **Step 4: Test discover**

```bash
cd D:\web-projects\web-client
npx tsx D:/web-projects/agent-view/src/cli/index.ts discover
```

Expected: JSON output with list of windows (at least one page with title and URL).

- [ ] **Step 5: Test dom**

```bash
cd D:\web-projects\web-client
npx tsx D:/web-projects/agent-view/src/cli/index.ts dom
```

Expected: Compact accessibility tree output with `role "name" [ref=N]` format.

- [ ] **Step 6: Test dom with filter**

```bash
npx tsx D:/web-projects/agent-view/src/cli/index.ts dom --filter "button"
```

Expected: Only nodes matching "button" in role/name.

- [ ] **Step 7: Test stop**

```bash
npx tsx D:/web-projects/agent-view/src/cli/index.ts stop
```

Expected: "Server stopped". Subsequent `discover` should auto-start a new server.

- [ ] **Step 8: Fix any issues found**

Iterate on code based on real CDP responses from Electron. Common issues:
- AX tree node structure differs from expected (childIds vs children)
- Target filtering for Electron (may have background_page, service_worker targets)
- Connection cleanup on errors

- [ ] **Step 9: Final commit**

```bash
cd D:/web-projects/agent-view
git add -A
git commit -m "fix: adjustments after integration testing on Electron app"
```

---

## Notes for Implementers

1. **Electron targets:** Electron exposes multiple targets — `page`, `background_page`, `service_worker`, `other`. Only `page` targets are actual windows. Filter in adapter.

2. **Server spawn on Windows:** `detached: true` + `child.unref()` on Windows may behave differently. If the server doesn't detach properly, consider using `start /b` via shell command.

3. **Port 47922 conflict:** If port is in use, server should fail with clear message. CLI should detect and suggest `agent-view stop` or check for orphaned process.

4. **chrome-remote-interface types:** The package doesn't have great TS types. May need `@types/chrome-remote-interface` or `// @ts-expect-error` in some places.

5. **TCP framing:** Current protocol relies on socket half-close for message boundary (client calls `socket.end()` with data, server reads until `end` event). This works reliably on localhost TCP but is not robust for general networking. Acceptable for v1, consider length-prefix framing if issues arise.

6. **`--depth` validation:** `commander`'s `parseInt` returns `NaN` for invalid input. Add a check in the CLI command handler or in `formatAccessibilityTree` to treat `NaN` as undefined.
