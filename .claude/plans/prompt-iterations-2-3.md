# Prompt: Execute Iterations 2 & 3 of agent-view

Use this prompt to continue development of agent-view in a new Claude Code session.

---

## Context

Read the following files FIRST, they contain all project context:
- `CLAUDE.md` — project conventions, stack, architecture
- `.claude.current-stage.md` — current status (iteration 1 completed)
- `agent-view-prd.md` — full PRD with all decisions

## What's already done (Iteration 1)

Working commands: `init`, `discover`, `dom`, `stop`. Lazy TCP server on port 47922. CDP transport via `chrome-remote-interface`. Tested on `D:\web-projects\web-client` (Electron + Vue 3).

Existing files:
```
src/types.ts, src/config/{types,manager}.ts, src/cdp/{types,transport}.ts,
src/adapters/{types,electron,browser,tauri,registry}.ts,
src/inspectors/dom.ts, src/server/{index,server,ref-store}.ts,
src/cli/{index,client}.ts, src/cli/commands/{init,discover,dom,stop}.ts
```

## Your task

Implement iterations 2 and 3 sequentially. Use `/work` skill or write plans via `superpowers:writing-plans`, then execute via `superpowers:subagent-driven-development`.

---

## Iteration 2: Interaction

### Commands to add: `launch`, `click`, `fill`, `screenshot`

### 2.1 — `agent-view launch`

**Spec (US-3):**
- Reads `config.launch` command (e.g. `npm run dev`)
- Spawns it as a detached background process
- Polls CDP port until `/json/list` returns targets (app is ready)
- Timeout with clear error if app doesn't start within 60s
- Idempotent: if app already running (CDP responds), prints status and exits

**Server handler:** `handleLaunch(req)` — needs `config.launch` passed via `req.args.launch`. Spawns process, polls `listTargets(port)` every 1s until non-empty.

**CLI command:**
```
agent-view launch    # Start app from config.launch, wait for CDP readiness
```

**Files to create/modify:**
- Create: `src/server/launcher.ts` — `launch(command, port): Promise<void>`, `isRunning(port): Promise<boolean>`
- Modify: `src/server/server.ts` — add `case 'launch'` in handleCommand
- Create: `src/cli/commands/launch.ts`
- Modify: `src/cli/index.ts` — register launch command

### 2.2 — `agent-view click`

**Spec (US-8):**
- `agent-view click <ref>` — click DOM element by session ref ID
- `agent-view click --pos <x,y>` — click by coordinates (for canvas)
- Returns success/error in stdout (plain text)

**Implementation:**
- Ref click: resolve `backendDOMNodeId` from RefStore → CDP `DOM.resolveNode({ backendNodeId })` → get `objectId` → `DOM.getBoxModel` or `DOM.scrollIntoViewIfNeeded` → `Input.dispatchMouseEvent` at element center
- Pos click: `Input.dispatchMouseEvent` at given x,y (mousePressed + mouseReleased)

**Server handler:** `handleClick(req)` — `req.args.ref` or `req.args.pos`

**CDPConnection needs new methods:**
- `clickByNodeId(backendNodeId: number): Promise<void>`
- `clickAtPosition(x: number, y: number): Promise<void>`

**Files to create/modify:**
- Modify: `src/cdp/types.ts` — add click methods to CDPConnection
- Modify: `src/cdp/transport.ts` — implement click via CDP Input domain
- Modify: `src/server/server.ts` — add `case 'click'`
- Create: `src/cli/commands/click.ts`
- Modify: `src/cli/index.ts` — register click command

### 2.3 — `agent-view fill`

**Spec (US-8):**
- `agent-view fill <ref> <value>` — type text into input by ref
- Returns success/error in stdout

**Implementation:**
- Resolve ref → focus element via `DOM.focus({ backendNodeId })` → `Input.insertText({ text })` or use `Runtime.evaluate` to set value + dispatch input event

**CDPConnection needs:**
- `fillByNodeId(backendNodeId: number, value: string): Promise<void>`

**Files to create/modify:**
- Modify: `src/cdp/types.ts` — add fill method
- Modify: `src/cdp/transport.ts` — implement fill
- Modify: `src/server/server.ts` — add `case 'fill'`
- Create: `src/cli/commands/fill.ts`
- Modify: `src/cli/index.ts` — register fill command

### 2.4 — `agent-view screenshot`

**Spec (US-7):**
- `agent-view screenshot` — capture PNG, save to temp dir, print path
- `--window <name|id>` — specific window
- Screenshot includes WebGL canvas content (use CDP `Page.captureScreenshot`)

**Implementation:**
- `captureScreenshot()` already exists in CDPConnection
- Save to `os.tmpdir()/agent-view-screenshot-{timestamp}.png`
- Return path in stdout

**Files to create/modify:**
- Modify: `src/server/server.ts` — add `case 'screenshot'`
- Create: `src/cli/commands/screenshot.ts`
- Modify: `src/cli/index.ts` — register screenshot command

### Integration test (Iteration 2)

Test on `D:\web-projects\web-client`:
1. `agent-view launch` → starts Electron, waits for CDP
2. `agent-view screenshot` → saves PNG, verify non-empty file
3. `agent-view click <ref>` → click a button from `dom` output
4. `agent-view dom` → verify UI changed after click
5. `agent-view fill <ref> <value>` → type into an input
6. `agent-view stop`

**After completing iteration 2 — update `.claude.current-stage.md`**

---

## Iteration 3: WebGL (PixiJS Scene Graph)

### Commands to add: `scene`, `snap`

### 3.1 — `agent-view scene`

**Spec (US-5):**
- Reads PixiJS scene graph via `window.__PIXI_DEVTOOLS__` through CDP `Runtime.evaluate`
- Returns compact text tree: each object has name, type, position (x,y), visible, tint
- `--filter <text>` — filter by name
- `--depth <N>` — limit depth
- `--verbose` — add scale, alpha, rotation, bounds
- `--diff` — return only changes vs previous call (diff cache in server memory)

**Implementation:**
- Create `src/inspectors/scene.ts` — `SceneInspector` that evaluates JS in browser context to serialize `__PIXI_DEVTOOLS__` scene graph
- The JS expression should walk `app.stage` children recursively and return serialized tree
- Format: `Container "name" (x,y) visible tint [depth indent]`

**Diff mode:** Server stores previous scene snapshot per window. On `--diff`, compare trees and return only changed/added/removed nodes.

**Files to create/modify:**
- Create: `src/inspectors/scene.ts` — scene graph serializer + diff logic
- Modify: `src/server/server.ts` — add `case 'scene'`, add scene cache for diff
- Create: `src/cli/commands/scene.ts`
- Modify: `src/cli/index.ts` — register scene command

### 3.2 — `agent-view snap`

**Spec (US-6):**
- Combines `dom` + `scene` in one call
- Output: DOM section, then Scene section, clearly separated
- Supports same flags (`--filter`, `--depth`, `--window`)

**Files to create/modify:**
- Modify: `src/server/server.ts` — add `case 'snap'` that calls both handleDom and handleScene
- Create: `src/cli/commands/snap.ts`
- Modify: `src/cli/index.ts` — register snap command

### Integration test (Iteration 3)

Scene graph testing requires a PixiJS app. If SCADA project is not available, create a minimal PixiJS fixture:
- `test-fixtures/pixi-app/index.html` — simple page with PixiJS stage, `@pixi/devtools` initialized, named objects
- Serve via `npx http-server` + open in Chrome with `--remote-debugging-port=9223`

Test:
1. `agent-view scene` → verify tree shows named PixiJS objects
2. `agent-view scene --filter <name>` → filtered results
3. `agent-view scene --verbose` → extended properties
4. `agent-view scene --diff` → first call full, second call only changes
5. `agent-view snap` → DOM + Scene combined

**After completing iteration 3 — update `.claude.current-stage.md`**

---

## Important patterns from Iteration 1

### IPC protocol
Client sends `JSON\n`, server processes async, responds `JSON\n`, then closes socket. Delimiter is `\n`. Never use TCP half-close.

### Server command routing
Add new commands in `handleCommand()` switch statement. Each handler returns `Promise<ServerResponse>`.

### Window resolution
Server resolves `--window` arg by ID first, then by title substring match. Same logic should be reused for all commands.

### CDP connection reuse
Connections cached in `this.connections` map by `port:targetId`. Reuse across commands within same session.

### IPv4
Always pass `host: '127.0.0.1'` to chrome-remote-interface.

### CLI command pattern
Each command is a separate file in `src/cli/commands/`. Registered in `src/cli/index.ts`. Commands that need config call `requireConfig()`. Commands send requests via `sendCommand()` from `client.ts`.

### Output format
All commands output plain text to stdout. Exception: `discover` outputs JSON. New commands (`click`, `fill`, `launch`, `screenshot`) output plain text status messages.

### Commits
One commit per logical unit. Message format: `feat: description` / `fix: description`.
Verify `npx tsc --noEmit` passes before each commit.

---

## After both iterations

1. Update `.claude.current-stage.md` with final status
2. Verify all commands work: `init`, `discover`, `launch`, `dom`, `scene`, `snap`, `screenshot`, `click`, `fill`, `stop`
3. Commit everything clean
