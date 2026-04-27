---
name: verify
description: "Visual + runtime verification of desktop apps via Chrome DevTools Protocol. Use when modifying UI components, fixing visual bugs, testing user interactions, verifying layout, or when any workflow phase needs to inspect the running application — DOM, screenshots, scene graph, runtime state in pages and SharedWorkers/ServiceWorkers, console errors, or reactive-state diffs over time. Triggers on: verify, check UI, test how it looks, visual regression, screenshot, inspect DOM, check store/state, watch state changes, what changed after click, wait until state, read worker, console errors, runtime check, eval in page."
allowed-tools: Bash(agent-view *), Bash(rtk agent-view *)
---

# Visual Verification with agent-view

You have access to `agent-view` CLI for inspecting and interacting with desktop applications via Chrome DevTools Protocol.

## Prerequisites

The target project must have:
1. `agent-view.config.json` in project root (run `agent-view init` to generate)
2. CDP enabled in the app (e.g. `--remote-debugging-port=9222` for Electron)

If config is missing, run `agent-view init` first.

## Commands Reference

### Discovery & Launch
```bash
agent-view launch                      # Start app from config, wait for CDP readiness
agent-view discover                    # List windows (JSON) — get window IDs
agent-view stop                        # Stop the lazy server
```

### DOM Inspection
```bash
rtk agent-view dom                          # DOM accessibility tree (default window)
rtk agent-view dom --window <id|name>       # Specific window
rtk agent-view dom --filter "button"        # Filter by text/role
rtk agent-view dom --depth 3                # Limit tree depth
```

### Interaction
```bash
agent-view click <ref>                  # Click element by ref from dom output
agent-view click --pos 100,200          # Click by coordinates (for canvas)
agent-view fill <ref> "text"            # Type into input field
agent-view drag --from <ref> --to <ref>          # Drag element to another element by ref
agent-view drag --from-pos 50,80 --to-pos 200,300  # Drag by coordinates (for canvas / Pixi)
agent-view drag --from <ref> --to <ref> --steps 25 --hold-ms 60  # Smoother movement, longer hold
```

`drag` dispatches `mousePressed` → N × `mouseMoved` → `mouseReleased` via CDP. Endpoints can mix
ref and coordinate (e.g. `--from <ref> --to-pos 400,300`). For canvas/Pixi targets always use
`--from-pos`/`--to-pos` — derive the centroid via `agent-view eval` from the scene graph.
Refs are resolved fresh on each call, so window resizes between snapshots are tolerated.
Increase `--steps` for handlers using `globalpointermove` so intermediate frames are not skipped.

### Screenshots
```bash
agent-view screenshot --scale 0.5              # Recommended: JPEG at half-res (~3× fewer vision tokens)
agent-view screenshot --scale 0.5 --window <id>  # Specific window
agent-view screenshot --crop "Sidebar"         # Crop to element bounding box (~1.6k tokens — 12× win)
agent-view screenshot --crop "Chart" --scale 0.5  # Crop + scale (stacks)
agent-view screenshot                          # Full-res PNG (expensive: ~19k tokens at 1920×1080)
```

`--crop <filter>` resolves the element with the same filter syntax as `dom --filter`, then crops the screenshot to its bounding box. Prefer `--crop` over full-window screenshots whenever you only need to inspect a specific section. Falls back to full-window with a stderr warning if the filter matches nothing.

### Runtime State (`eval`)

Reads runtime values DOM/screenshot can't reveal — store contents, computed flags, worker internals.
**Requires `"allowEval": true` in `agent-view.config.json`** — if the call returns "eval is disabled", tell the user to add the flag rather than working around it.

```bash
agent-view eval "store.state.user.role"                       # default page target
agent-view eval --window "Settings" "router.currentRoute.path"
agent-view eval --target sync-worker "self.queue.length"      # SharedWorker / ServiceWorker by id or substring
agent-view eval --await "fetch('/api/health').then(r => r.status)"
agent-view eval --json "({ buttons: document.querySelectorAll('button').length })"
```

When to reach for `eval` instead of `dom`:
- The truth lives in JS state, not the DOM (Pinia/Vuex/Redux/Zustand store, Vue refs, computed values, app singletons).
- The target is a worker (`shared_worker`, `service_worker`, `worker`) — DOM doesn't exist there.
- You need a precise number/string answer, not a tree to scan.

### Reactive State (`watch`)

Streams JSON-patch diffs of an expression over time. Use when you need to see *what changed* between an action and a final state — `eval` shows the snapshot, `watch` shows the trajectory. **Requires `"allowEval": true`.**

```bash
agent-view watch "store.cart.total"                                # 250ms poll, default 10 changes or 30s
agent-view watch "appState" --until "appState.status === 'ready'"  # wait-for-condition with diff log
agent-view watch "store.user" --max-changes 1                      # capture exactly one change after a click
agent-view watch "appState" --json                                 # NDJSON, machine-readable
```

When to reach for `watch` instead of `eval`:
- Debugging "the click did X but state shows Y — what happened in between?"
- Time-based assertions ("wait until store.status === 'ready'") — `--until` exits cleanly when truthy.
- Confirming an action triggered the *expected* sequence of mutations, not just the final state.

Output: `init` line (baseline), one line per RFC 6902 op (`replace /path old → new`, `add /items/0 ...`), final `stop` line with reason. Snapshot size cap 256 KB — narrow the expression (`store.x.y`, not `store`) for large objects.

### Console (`console`)

Streams `Runtime.consoleAPICalled` + `Log.entryAdded`. Use to confirm a flow finished without errors, or to surface a specific warning after an interaction.

```bash
agent-view console                              # buffered messages from auto-attached targets
agent-view console --level error,warn           # filter
agent-view console --target sync-worker         # one target
agent-view console --follow --timeout 10        # stream window (use sparingly — 10s of waiting)
agent-view console --clear                      # baseline before an interaction
agent-view console --since "2026-04-26T10:00:00Z"
```

Standard pattern for "did this action error?":
```bash
agent-view console --clear
agent-view click --filter "Save"
agent-view wait --filter "Saved"
agent-view console --level error                # expect "(no console messages)"
```

Default attached target types: `page`, `shared_worker`, `service_worker` (override via `consoleTargets` in config).

### Targets (`targets`)

When `--window` doesn't show what you expected, or you need a worker target id for `eval`/`console`:

```bash
agent-view targets                                       # everything connectable
agent-view targets --type shared_worker,service_worker   # filter
agent-view targets --json                                # machine-readable
```

You usually don't need this — `eval --target <substring>` and `--window <name>` both do fuzzy matching. Reach for `targets` when the substring is ambiguous.

### Scene / Canvas / WebGL (only when `webgl` is configured in agent-view.config.json)

These commands read the scene graph from canvas-based rendering engines. Skip this section if the project has no `webgl` field in config.

```bash
agent-view scene                        # Scene graph from configured engine
agent-view scene --filter "player"      # Filter by object name/type
agent-view scene --verbose              # Extended props (scale, alpha, rotation)
agent-view scene --diff                 # Changes since last call
agent-view snap                         # DOM + Scene combined
```

## Picking the right tool

Verifications cost very different amounts. Pick the cheapest tool that can actually answer the question:

| The question is about… | Use | Why |
|---|---|---|
| Element existence / text / role | `dom --filter` | Cheapest, structured, no vision tokens |
| App state, store contents, computed values | `eval "expr"` | DOM doesn't expose JS state; reading the tree to infer it is wasteful and unreliable |
| State *trajectory* — what changed during/after an action | `watch "expr" --until …` or `--max-changes 1` | `eval` shows the final snapshot only; `watch` shows the diffs in order |
| Worker logic (SharedWorker / ServiceWorker) | `eval --target <name>` | Workers have no DOM at all |
| Did the last action throw or warn? | `console --clear` before, `console --level error,warn` after | Catches errors that don't surface in the DOM |
| Layout/visual of a specific element | `screenshot --crop "<element>"` | ~1.6k tokens (1 tile) — crops to bounding box, massive token win |
| Layout, spacing, full-window visual regression | `screenshot --scale 0.5` | The only tool that sees pixels — but expensive (~6k tokens), use last |
| Canvas/WebGL scene contents | `scene --diff` | DOM is empty for canvas apps |

When two tools could answer the same question, prefer the one higher up the table. A common mistake is screenshotting to check "is the count = 5?" when `eval "store.counter"` returns the number directly for ~50 tokens.

## Verification Workflow

### Ad-hoc Mode (standalone)

After making code changes:

1. **Determine affected areas** from git diff
2. **Ensure app is running**: `agent-view launch` or `agent-view discover`
3. **Inspect DOM**: `rtk agent-view dom --filter "<area>" --depth 2` — check structure matches expectations
4. **Interact if needed**: `agent-view click`/`fill` → `rtk agent-view dom --filter` to verify state changed
5. **For canvas apps**: `agent-view scene --diff` to see what changed
6. **For non-DOM truth** (store, computed values, worker state): `agent-view eval` — much cheaper than reading the DOM tree to infer state
7. **After any interaction that could fail silently**: `agent-view console --level error` — catches uncaught exceptions, network failures, framework warnings
8. **Screenshot only for final visual confirm**: `agent-view screenshot --scale 0.5` — captures layout/styling that DOM can't reveal

### Scenario Execution Mode (from plan)

When UI scenarios are pre-generated (e.g., from a plan file with `## UI Scenarios` section):

1. **Read scenario steps** with symbolic refs (`$var` notation)
2. **Resolve each $var**: `agent-view dom --filter "<text>" --depth 3` → map to ref ID
3. **Execute steps** sequentially: fill, click, dom --filter (verify expected outcome)
4. **Screenshot**: `agent-view screenshot --scale 0.5` — only on FAIL and at E2E scenario end, not every step
5. **Report per-scenario**: PASS / FAIL with reason and evidence

This mode works with any workflow that generates plan files with UI scenarios.

## Resilience

- **Stale refs:** After HMR, navigation, or state change — re-run `dom` for fresh refs before interacting
- **Element not found:** Wait 2s, retry once (render delay after HMR). If still missing — report FAIL
- **CDP disconnect:** Run `agent-view discover` to check. If no windows — `agent-view launch`
- **Max retries per command:** 2. After that — SKIP scenario step with warning

## Important Notes

- **Refs are session-scoped** — after HMR or navigation, run `dom` again for fresh refs
- **Multiple windows**: use `--window <id>` from `discover` output when titles overlap
- **Multiwindow**: all commands support `--window` flag
- **Output format**: plain text (DOM, scene), JSON (discover only), file path (screenshot)
- **Lazy server**: auto-starts on first call, shuts down after 5min idle

## Token Optimization

Vision tokens dominate cost. One full-res screenshot ≈ 19k tokens (1920×1080, 12 tiles).

| Technique | Savings |
|---|---|
| `agent-view eval "expr"` for state checks | Returns one value (~50 tokens) instead of a DOM/screenshot |
| `rtk agent-view dom --filter X --depth 2` | Compresses text output via RTK |
| `agent-view screenshot --scale 0.5` | ~3× fewer vision tokens (4 tiles) |
| `agent-view screenshot --scale 0.25` | ~12× fewer vision tokens (1 tile, ~1.6k tokens) |
| `agent-view screenshot --crop "<element>"` | ~12× fewer in best case (1 tile) — crops to element bounding box |
| DOM/eval-first: screenshot only for final visual confirm | Eliminates most screenshot calls |

**Default rule**: if the answer is a value → `eval`; if the answer is "is element X visible/correct?" → `rtk agent-view dom --filter`; if you need pixels for a specific section → `screenshot --crop "<element>"` (one tile); only call `screenshot --scale 0.5` for full-window visual proof.
