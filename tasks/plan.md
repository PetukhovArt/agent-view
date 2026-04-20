# Plan: agent-view v0.2.0 — CDP Performance Optimization

Source spec: `SPEC.md`

---

## Dependency Graph

```
Task 1: Benchmark harness (bench/app + bench/run.ts + baseline.json)
   │
   ├── Task 2: Opt B — parallel click (transport.ts only, isolated)
   │      └── Checkpoint A ──────────────────────────────────────────┐
   │                                                                  │
   ├── Task 3: Opt A — AX tree cache (ax-cache.ts + transport + server)
   │      └── Checkpoint B ──────────────────────────────────────────┤
   │                                                                  │
   └── Task 4: Opt C — queryAXTree routing (types + transport + server)
          └── Checkpoint C ──────────────────────────────────────────┘
                                                                      │
                                                              Task 5: Finalize
```

**Key constraints:**
- Tasks 2, 3, 4 all touch `transport.ts` — must be done sequentially, not in parallel
- Task 4 adds a new method to the `CDPConnection` interface in `types.ts` — no other task touches this interface
- Task 3 modifies `server.ts` (cache bust) and Task 4 also modifies `server.ts` (filter routing) — sequential
- All 67 existing tests must pass after every task

---

## Task 1: Benchmark Harness

**Goal:** Establish reproducible baseline numbers before any optimization touches production code.

### 1a — bench/app/ minimal Electron app

Create `bench/app/` with a pinned Electron shell and fixed HTML:

**`bench/app/package.json`**
- `electron` pinned to latest stable (e.g. `^33`)
- `start` script: `electron main.js --remote-debugging-port=19222`
- No build step needed

**`bench/app/main.js`**
- Electron `BrowserWindow` that loads `index.html`
- `webPreferences: { nodeIntegration: false, contextIsolation: true }`
- Window size: 1280×800

**`bench/app/index.html`**
Fixed DOM with exactly ~200 AX nodes:
- 20 buttons with unique accessible names
- 10 text inputs with labels
- 3 nested lists (ul > li × 10 each) with roles
- 2 modal-like sections (hidden via `aria-hidden`)
- 1 form with fieldset/legend
- Semantic HTML only — no JS frameworks
- One inline `<script>`: on `DOMContentLoaded`, `setTimeout(() => { append button "Async Button" }, 200)` — required for the `wait_match` benchmark scenario

This set exercises: role lookup, name resolution, nested traversal, hidden node filtering.

### 1b — bench/run.ts

Runner that:
1. Spawns `bench/app` via `child_process.spawn`
2. Starts `AgentViewServer` in-process on a fixed port (e.g. 47200) pointing at the bench Electron app
3. Sends raw TCP commands to the server (same JSON protocol the CLI uses) — this covers `resolveWindow`/`adapter.discover()` overhead, which `connectToTarget` alone misses
4. Runs each scenario N=10 times, reports median + p95 in ms
5. Writes results to `bench/results.json`
6. Prints delta vs `bench/baseline.json` if it exists

**Note on benchmark layer:** Agents pay CLI spawn + server lookup (`adapter.discover()` = CDP.List call) + command execution costs. Calling `connectToTarget` directly skips `resolveWindow` overhead and gives artificially low warm numbers. End-to-end TCP-to-server captures the real cost.

**Scenarios:**
```
dom_cold          – full dom command via server (includes resolveWindow)
dom_warm          – second dom command within 300ms (baseline: no cache yet)
click_filter_cold – click --filter "Button 10" via server (cold)
click_filter_warm – same filter, second call within 300ms
fill_filter_cold  – fill --filter "Input 5" via server (cold)
wait_match        – wait for element that appears after 200ms delay (bench/app injects it via setTimeout)
cycle_dom_click_dom – dom → click --filter → dom end-to-end
```

### 1c — Commit baseline

Run `npx tsx bench/run.ts`, copy `bench/results.json` to `bench/baseline.json`, commit.

### Acceptance
- `bench/app` starts cleanly with `electron main.js --remote-debugging-port=19222`
- `bench/run.ts` completes all 7 scenarios, outputs median/p95 per scenario
- `bench/baseline.json` committed with real numbers
- Existing 67 tests unaffected

---

## Task 2: Opt B — Parallel CDP Calls in Click

**Scope:** `src/cdp/transport.ts` only. Zero changes to any other file.

### What changes in `clickByNodeId`

**Current (5 serial round-trips):**
```
1. DOM.resolveNode(backendNodeId)           → objectId
2. Runtime.callFunctionOn(objectId, scroll) → (needs step 1)
3. DOM.getBoxModel(backendNodeId)           → content coords
4. Input.dispatchMouseEvent(mousePressed)
5. Input.dispatchMouseEvent(mouseReleased)  → (awaited separately)
```

**New (3 batches):**
```
Batch 1: Promise.all([DOM.resolveNode, DOM.getBoxModel])
         – resolveNode: needs objectId for scroll
         – getBoxModel: takes backendNodeId directly, independent
Batch 2: Runtime.callFunctionOn(scroll)    – needs objectId from batch 1
Batch 3: send mousePressed (no await)
         send mouseReleased (no await)
         await Promise.all([pressedResult, releasedResult])
```

**Fire-and-forget semantics:** Both mouse events are sent before either response
is awaited. The browser processes WebSocket messages in send order, so
`mouseReleased` always follows `mousePressed` in the event queue. Responses are
awaited together after both sends to catch any CDP errors.

Note: `chrome-remote-interface` returns a Promise per command the moment you call
it — the WebSocket message is sent immediately. Awaiting the Promise only blocks
on the response, not the send.

### Unit test additions (`src/cdp/transport.test.ts` — new file)

- Mock CDP client that records call order and timing
- Assert `DOM.resolveNode` and `DOM.getBoxModel` are called before scroll
- Assert `mousePressed` send precedes `mouseReleased` send
- Assert both mouse events fire for a successful click
- Assert correct center coordinates calculated from box model content array

### Acceptance
- All 67 existing tests green
- New transport tests pass
- Manual smoke: click on bench/app button works correctly
- Benchmark: `click_filter_cold` p95 lower than baseline

---

## Checkpoint A

Before proceeding to Task 3:
- [ ] `pnpm test` — all tests green (67 + new transport tests)
- [ ] `bench/run.ts` — record Task 2 contribution to `bench/results.json`
- [ ] Git commit: `perf: parallel CDP calls in clickByNodeId (Opt B)`

---

## Task 3: Opt A — AX Tree Cache

**Scope:** New `src/cdp/ax-cache.ts` + modifications to `src/cdp/transport.ts` and `src/server/server.ts`.

### 3a — `src/cdp/ax-cache.ts`

Single-responsibility module. No imports from server or inspectors.

```typescript
const AX_CACHE_TTL_MS = 300

type CacheEntry = {
  nodes: AXNode[]
  timestamp: number
}

export class AxTreeCache {
  private entries = new Map<string, CacheEntry>()

  get(key: string): AXNode[] | null
  set(key: string, nodes: AXNode[]): void
  invalidate(key: string): void
  invalidateAll(): void  // for shutdown/tests
}
```

`get` returns `null` if entry is missing or older than `AX_CACHE_TTL_MS`.

### 3b — Wire into `transport.ts`

`connectToTarget` receives a shared `AxTreeCache` instance (injected, not created
internally — keeps transport testable).

`getAccessibilityTree()` implementation:
```
key = `${port}:${targetId}`
cached = axTreeCache.get(key)
if cached → return cached
nodes = await Accessibility.getFullAXTree()
axTreeCache.set(key, nodes)
return nodes
```

Subscribe to `Page.frameNavigated` at connect time:
```
Page.frameNavigated(() => axTreeCache.invalidate(key))
```

`connectToTarget` signature change:
```typescript
// before
connectToTarget(port: number, targetId: string): Promise<CDPConnection>

// after
connectToTarget(port: number, targetId: string, cache: AxTreeCache): Promise<CDPConnection>
```

### 3c — Wire into `server.ts`

`AgentViewServer` owns the single `AxTreeCache` instance (same lifetime as server).

Pass it into `connectToTarget` via the adapter. The adapter `connect` method already
calls `connectToTarget` — add `cache` parameter through the chain:
`adapter.connect(port, targetId, cache)`.

Bust cache in mutating handlers:
```typescript
// handleClick — after conn.clickByNodeId / clickAtPosition
axTreeCache.invalidate(`${req.port}:${targetId}`)

// handleFill — after conn.fillByNodeId
axTreeCache.invalidate(`${req.port}:${targetId}`)
```

Note: `handleScreenshot` does NOT mutate DOM — no bust needed.

### Interface changes

`RuntimeAdapter.connect` gains a `cache` parameter. All three adapter files
(`browser.ts`, `electron.ts`, `tauri.ts`) pass it through to `connectToTarget`.

### Unit tests (`src/cdp/ax-cache.test.ts`)

- `get` returns null on empty cache
- `get` returns nodes within TTL
- `get` returns null after TTL expires (mock `Date.now`)
- `invalidate` clears specific key, leaves others
- `set` overwrites existing entry

Integration test via mock `CDPConnection`:
- `getAccessibilityTree` called twice within 300ms → second call returns cache, zero CDP calls on second
- `clickByNodeId` → `getAccessibilityTree` → CDP called (cache busted)
- `Page.frameNavigated` fires → next `getAccessibilityTree` hits CDP

### Acceptance
- All tests green
- `dom_warm` benchmark latency significantly lower than `dom_cold`
- `click_filter_warm` latency significantly lower than `click_filter_cold`
- `dom` after `click` fetches fresh (no stale state)

---

## Checkpoint B

Before proceeding to Task 4:
- [ ] `pnpm test` — all tests green
- [ ] `bench/run.ts` — record Task 3 contribution
- [ ] `dom_warm` result ≤ 20ms (should be near zero — only formatting cost)
- [ ] Git commit: `perf: AX tree cache with 300ms TTL (Opt A)`

---

## Task 4: Opt C — `queryAXTree` for Role+Name Filters

**Scope:** `src/cdp/types.ts`, `src/cdp/transport.ts`, `src/server/server.ts`.

### 4a — Extend `CDPConnection` interface (`types.ts`)

Add one method:
```typescript
queryAXTree: (params: { accessibleName?: string; role?: string }) => Promise<AXNode[]>
```

Returns the matching nodes from the browser's AX tree without fetching the full
tree. Returns empty array if no match.

### 4b — Implement in `transport.ts`

**Important:** `Accessibility.queryAXTree` requires a subtree root — one of
`nodeId`, `backendNodeId`, or `objectId`. It cannot be called with just
`{accessibleName, role}`. We need the document root's `backendNodeId`.

Fetch and cache the document root once at connect time:
```typescript
const { root } = await DOM.getDocument({ depth: 0 })  // depth:0 = root only, cheap
let documentBackendNodeId = root.backendNodeId
```

Invalidate on `Page.frameNavigated` (same handler as AX cache invalidation):
```typescript
Page.frameNavigated(async () => {
  axTreeCache.invalidate(key)
  const { root } = await DOM.getDocument({ depth: 0 })
  documentBackendNodeId = root.backendNodeId
})
```

`queryAXTree` implementation:
```typescript
async queryAXTree({ accessibleName, role }) {
  try {
    const { nodes } = await Accessibility.queryAXTree({
      backendNodeId: documentBackendNodeId,
      accessibleName,
      role,
    })
    return nodes as AXNode[]
  } catch {
    return null  // null = API unavailable; [] = available but no match
  }
}
```

Return type: `Promise<AXNode[] | null>` — `null` = API unavailable, `[]` = no results.

Track per-connection availability to avoid repeated try/catch overhead:
```typescript
let queryAXTreeAvailable: boolean | null = null  // null = not yet tested
```

On first `null` return, flip to `false` — subsequent filter calls skip
`queryAXTree` entirely and use the full-tree path.

### 4c — Filter routing logic (`server.ts`)

Extract `parseFilter`:
```typescript
type ParsedFilter =
  | { kind: 'simple'; name: string; role?: string }
  | { kind: 'heuristic'; raw: string }

const ARIA_ROLES = new Set([
  'button', 'link', 'menuitem', 'tab', 'checkbox', 'radio',
  'textbox', 'searchbox', 'combobox', 'spinbutton', 'textarea',
  'listitem', 'option', 'treeitem', 'cell', 'row', 'heading',
])

function parseFilter(filter: string): ParsedFilter {
  // "role:name" syntax — only recognized ARIA roles prevent false matches (e.g. "localhost:3000")
  const colonIdx = filter.indexOf(':')
  if (colonIdx > 0) {
    const role = filter.slice(0, colonIdx).trim().toLowerCase()
    const name = filter.slice(colonIdx + 1).trim()
    if (name && ARIA_ROLES.has(role)) {
      return { kind: 'simple', name, role }
    }
  }
  // heuristic: starts with ~ or contains regex special chars
  if (filter.startsWith('~') || /[.*+?^${}()|[\]\\]/.test(filter)) {
    return { kind: 'heuristic', raw: filter }
  }
  // plain string → name lookup
  return { kind: 'simple', name: filter }
}
```

Update `findByFilter` to use routing:

```
parsed = parseFilter(filter)
if parsed.kind === 'simple' AND connection supports queryAXTree:
  nodes = await conn.queryAXTree({ accessibleName: parsed.name, role: parsed.role })
  if nodes === null:
    mark connection as queryAXTree=unavailable, fall through to full tree
  else if nodes.length > 0:
    assign ref to found node(s), return best match per preferRoles
  else:
    return null  // not found, NO full-tree fallback
else:
  use existing full-tree path (getAccessibilityTree + formatAccessibilityTree)
```

### 4d — Ref store population for queryAXTree results

When `queryAXTree` returns nodes, those nodes need refs assigned — same as the
full-tree path. Because `queryAXTree` returns `AXNode[]` (same shape as
`getFullAXTree`), we can pass them directly through `formatAccessibilityTree`
with no filter (they're already the result).

```typescript
const { refs, nextRef } = formatAccessibilityTree(nodes, {
  startRef: this.refStore.getNextRef(),
})
this.refStore.store(refs, req.port, targetId, nextRef)
```

This ensures refs are assigned and the agent can follow up with `click <ref>`.

### Unit tests (`src/server/server.test.ts` — new file, or extend existing)

- `parseFilter('Save')` → `{ kind: 'simple', name: 'Save' }`
- `parseFilter('button:Save')` → `{ kind: 'simple', name: 'Save', role: 'button' }`
- `parseFilter('~some text')` → `{ kind: 'heuristic' }`
- `parseFilter('text.*regex')` → `{ kind: 'heuristic' }`
- `parseFilter('Save as Draft')` → `{ kind: 'simple', name: 'Save as Draft' }`
- Mock conn where `queryAXTree` returns null → falls back to full tree
- Mock conn where `queryAXTree` returns `[]` → returns "not found" (no second CDP call)
- Mock conn where `queryAXTree` returns node → ref assigned, click proceeds

### Acceptance
- All tests green
- `click_filter_cold` with simple filter uses `queryAXTree` path (verified in transport mock)
- `click_filter_cold` with `~` prefix uses full-tree path
- No regression on `click --ref` path
- Benchmark: `click_filter_cold` ≤ baseline × 0.5

---

## Checkpoint C

- [ ] `pnpm test` — all tests green
- [ ] `bench/run.ts` — full benchmark run, all 7 scenarios
- [ ] `click_filter_cold` ≤ baseline × 0.5 (acceptance from SPEC)
- [ ] `click_filter_warm` ≤ cold × 0.3

---

## Task 5: Finalize

1. Fill in acceptance criteria table in `SPEC.md` with actual baseline + v0.2.0 numbers
2. Bump version in `package.json` to `0.2.0`
3. Update `CHANGELOG.md` with v0.2.0 section
4. Update `.claude.current-stage.md`
5. Final commit: `chore: release v0.2.0 — CDP performance optimization`
6. Tag: `git tag v0.2.0`

---

## Files Created / Modified

| File | Status | Task |
|---|---|---|
| `bench/app/package.json` | NEW | 1 |
| `bench/app/main.js` | NEW | 1 |
| `bench/app/index.html` | NEW | 1 |
| `bench/run.ts` | NEW | 1 |
| `bench/baseline.json` | NEW | 1 |
| `bench/results.json` | NEW (gitignored) | 1 |
| `src/cdp/transport.ts` | MODIFIED | 2, 3, 4 |
| `src/cdp/transport.test.ts` | NEW | 2 |
| `src/cdp/ax-cache.ts` | NEW | 3 |
| `src/cdp/ax-cache.test.ts` | NEW | 3 |
| `src/cdp/types.ts` | MODIFIED | 4 |
| `src/server/server.ts` | MODIFIED | 3, 4 |
| `src/server/server.test.ts` | NEW | 4 |
| `src/adapters/browser.ts` | MODIFIED | 3 (cache param) |
| `src/adapters/electron.ts` | MODIFIED | 3 (cache param) |
| `src/adapters/tauri.ts` | MODIFIED | 3 (cache param) |
| `src/adapters/types.ts` | MODIFIED | 3 (cache param in interface) |
| `SPEC.md` | MODIFIED | 5 (fill in numbers) |
| `CHANGELOG.md` | MODIFIED | 5 |
| `package.json` | MODIFIED | 5 (version bump) |
