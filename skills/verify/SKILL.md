---
name: verify
description: "Visual + runtime verification of desktop apps via Chrome DevTools Protocol. Use when modifying UI components, fixing visual bugs, testing user interactions, verifying layout, or when any workflow phase needs to inspect the running application — DOM, screenshots, scene graph, runtime state in pages and SharedWorkers/ServiceWorkers, console errors, or reactive-state diffs over time. Triggers on: verify, check UI, test how it looks, visual regression, screenshot, inspect DOM, check store/state, watch state changes, what changed after click, wait until state, read worker, console errors, runtime check, eval in page."
allowed-tools: Bash(agent-view *), Read
---

# Visual Verification with agent-view

You have access to `agent-view` CLI for inspecting and interacting with desktop applications via Chrome DevTools Protocol.

## Prerequisites

The target project must have:
1. `agent-view.config.json` in project root (run `agent-view init` to generate)
2. CDP enabled in the app (e.g. `--remote-debugging-port=9876` for Electron — avoid `9222`, it's Chrome's own default and collides when Chrome is open)

If config is missing, run `agent-view init` first.

## Commands Reference

### Discovery & Launch
```bash
agent-view launch                      # Start app from config, wait for CDP readiness (all runtimes incl. Tauri)
agent-view discover                    # List windows (JSON) — get window IDs
agent-view stop                        # Stop the lazy server
```

**Port conflict**: if the configured port is held by a non-CDP process (e.g. a stray webpack-dev on the same port), `agent-view launch` exits non-zero with `code: PORT_CONFLICT` and reports the owning PID/process name. Ask the user to either close that process or start the app manually — do not kill foreign processes from the skill.

**Tauri**: launch works the same as Electron, but the wait timeout is 10 min (cargo builds are slow). If you see a port conflict on the Tauri devUrl port, it's almost always a parallel browser-dev — surface the PID and ask the user.

### DOM Inspection
```bash
agent-view dom                          # DOM accessibility tree (default window)
agent-view dom --window <id|name>       # Specific window
agent-view dom --filter "button"        # Filter by text/role
agent-view dom --depth 3                # Limit tree depth
agent-view dom --compact                # Merge single-child chains onto one line (~40-60% fewer tokens)
agent-view dom --count                      # Count of all visible nodes (single integer line)
agent-view dom --filter "row" --count       # Count matching nodes — e.g. "does this table have 5 rows?"
agent-view dom --max-lines 200          # Hard line budget; refs for truncated nodes still stored
agent-view dom --diff                   # Lines changed since last dom call (+ added / - removed)
```

`--count` skips tree output and ref mutations — cheapest way to assert "element exists N times" without loading the full tree into context.

### Interaction
```bash
agent-view click <ref>                  # Click element by ref from dom output
agent-view click --pos 100,200          # Click by coordinates (for canvas)
agent-view click <ref> --double         # Double-click (fires dblclick handlers); works with --filter / --pos too
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
agent-view screenshot --crop "Active bookings" --crop-up 1  # Crop the card, not just its heading
agent-view screenshot                          # Full-res PNG (expensive: ~19k tokens at 1920×1080)
```

`--crop <filter>` resolves the element with the same filter syntax as `dom --filter`, then crops the screenshot to its bounding box. Prefer `--crop` over full-window screenshots whenever you only need to inspect a specific section. Falls back to full-window with a stderr warning if the filter matches nothing.

A text filter usually matches the text-bearing node, so cropping on a section title returns a thin strip of that title. `--crop-up <n>` climbs `n` element ancestors before cropping — use `1` (sometimes `2`) to get the surrounding card/section. When a crop comes back text-sized, the command says so on stderr.

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
- Verifying a `window.*` API or globally-exposed object exists. `eval` runs in the page's **main world**, so anything set on `window` directly or exposed via `contextBridge.exposeInMainWorld` is reachable. APIs placed only in an isolated-world preload (without `contextBridge`) will NOT be visible — that is not an agent bug, that is the host app's wiring.

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
agent-view console --target sync-worker         # one target (title/URL substring, same fuzzy semantics as eval --target)
agent-view console --target IJ56KL              # one target (exact id)
agent-view console --follow --timeout 10        # stream window (use sparingly — 10s of waiting)
agent-view console --follow --until "ready"     # exit as soon as a message contains "ready"
agent-view console --follow --until "/error/i"  # exit on regex match (case-insensitive)
agent-view console --clear                      # baseline before an interaction
agent-view console --since "2026-04-26T10:00:00Z"
```

`--until` requires `--follow`. Exits immediately when a message matches (substring or `/regex/flags`). On timeout without match exits non-zero.

Standard pattern for "did this action error?":
```bash
agent-view console --clear
agent-view click --filter "Save"
agent-view wait --filter "Saved"
agent-view console --level error                # expect "(no console messages)"
```

Default attached target types: `page`, `shared_worker`, `service_worker` (override via `consoleTargets` in config).

### Log feed (`logs`)

`console` reads a ring buffer that dies with the server; `logs` records the same messages — page *and* every worker — into one file you can grep later. Reach for it when a bug needs a timeline instead of a snapshot: intermittent failures, long scenarios, anything spanning reloads or worker restarts.

```bash
agent-view logs start --truncate           # start clean; keeps recording across reloads
agent-view logs                            # tail last 200 records (alias of `logs tail`)
agent-view logs tail --grep "ws closed"    # substring or /regex/
agent-view logs tail --since -2m           # -30s | -5m | -2h | 09:31 | 09:31:02.500 | ISO
agent-view logs tail --level error,warn -n 50
agent-view logs clear                      # truncate feed + drop console buffer (baseline)
agent-view logs status                     # attached targets, feed size, tick count
agent-view logs stop
```

Feed format — one record per line, always `HH:MM:SS.mmm [level] [type:id8] text`, local time, embedded newlines escaped as `\n`. That makes external `grep`/`awk` safe on it; a wrapped stack or JSON payload never breaks line-oriented filtering.

Default file `.agent-view/console.log` in the project root (override with `logFile` in config or `--file`). Caps at 8 MB, then rotates once to `<file>.prev` (`logMaxBytes` to change). Recording suspends the server's 5-min idle shutdown, so a long scenario keeps writing.

Standard pattern for "it fails once every N runs":
```bash
agent-view logs start --truncate
# … drive the scenario, reload, retry as many times as needed …
agent-view logs tail --level error,warn
agent-view logs tail --grep "/socket|retry/" --since -5m
agent-view logs stop
```

**Probes** (`--probe <file.js>[@target]`, requires `allowEval`) inject JS that logs into the same feed — use it when the evidence you need isn't logged by the app (wrap a method, count events, dump a scheduler). The probe is re-injected automatically whenever its context is gone: page reload, worker restart. Write it idempotent and let it report via plain `console.log`.

```bash
agent-view logs start --probe ./probes/orchestrator.js@shared_worker --probe ./probes/audio.js@index.html
```

### Network (`network`)

Request/response timeline, headers, timing, bodies, and WebSocket/SSE frames. Use to confirm an expected API call fired, diagnose a silent 404 / CORS block / missing auth header, or verify "button disabled until the network completes".

```bash
agent-view network                              # recent requests, newest at the bottom
agent-view network --req 3                       # expand one: headers, timing, body / WS frame log
agent-view network --status 4xx,5xx              # only failures (class or exact code, e.g. 404)
agent-view network --method POST                 # mutations among reads
agent-view network --type xhr,fetch              # drop document/image/font noise
agent-view network --url "*/api/save*"           # URL substring or * glob
agent-view network --follow --until "/api/save"  # stream until a matching request fires
agent-view network --clear                       # baseline before an interaction
```

**Eager, unlike `console`.** `network` captures from app launch, so page-load traffic (initial XHR/fetch, auth handshakes, boot 404s) is usually already buffered by the time you call it — in most cases you don't need to reload. `console` is the opposite (lazy: attaches on first call, loses earlier output). Call this asymmetry out so it isn't mistaken for a bug. Caveat: for very fast apps the earliest request can fire before capture attaches. If boot traffic looks missing, don't conclude "no request fired" — reload (`agent-view eval "location.reload()"`) and re-check before deciding.

`[req=N]` handles are reallocated on every list call (like `dom` refs) — expand from the most recent list. Sensitive headers are redacted by default (`--raw-headers` reveals them). Response/request **bodies** require `"captureBody": true` in config; WebSocket frame payloads are visible by default.

Standard pattern for "did the save call fire and succeed?":
```bash
agent-view network --clear
agent-view click --filter "Save"
agent-view wait --filter "Saved"
agent-view network --url "*/api/save*"          # expect one POST with status 200
```

### Targets (`targets`)

When `--window` doesn't show what you expected, or you need a worker target id for `eval`/`console`:

```bash
agent-view targets                                       # everything connectable
agent-view targets --type shared_worker,service_worker   # filter
agent-view targets --json                                # machine-readable
```

You usually don't need this — `eval --target <substring>` and `--window <name>` both do fuzzy matching. Reach for `targets` when the substring is ambiguous.

`targets` prints ids truncated to 8 chars, and `--target` / `--window` accept that printed handle (case-insensitive id prefix, ≥4 chars) as well as a full id or a title/URL substring. An ambiguous prefix is reported as ambiguous rather than resolved to an arbitrary target. Worker targets often share a blank title, so the printed id prefix is the reliable handle for them.

### Scene / Canvas / WebGL (only when `webgl` is configured in agent-view.config.json)

These commands read the scene graph from canvas-based rendering engines. Skip this section if the project has no `webgl` field in config.

```bash
agent-view scene                        # Scene graph from configured engine
agent-view scene --filter "player"      # Filter by object name/type
agent-view scene --verbose              # Extended props (scale, alpha, rotation)
agent-view scene --diff                 # Changes since last call
agent-view scene --compact              # Merge single-child chains onto one line (reduces output)
agent-view snap                         # DOM + Scene combined
agent-view snap --scale 0.5             # DOM + Scene + Screenshot (path appended as === Screenshot === section)
```

## Picking the right tool

Verifications cost very different amounts. Pick the cheapest tool that can actually answer the question:

| The question is about… | Use | Why |
|---|---|---|
| Element existence / text / role | `dom --filter` | Cheapest, structured, no vision tokens |
| Count of matching elements | `dom --filter X --count` | Single integer, no tree output, no ref mutations |
| App state, store contents, computed values | `eval "expr"` | DOM doesn't expose JS state; reading the tree to infer it is wasteful and unreliable |
| Does `window.X` / a globally-exposed API exist? | `eval "typeof window.X"` | DOM doesn't show JS globals; only authoritative check |
| State *trajectory* — what changed during/after an action | `watch "expr" --until …` or `--max-changes 1` | `eval` shows the final snapshot only; `watch` shows the diffs in order |
| Worker logic (SharedWorker / ServiceWorker) | `eval --target <name>` | Workers have no DOM at all |
| Did the last action throw or warn? | `console --clear` before, `console --level error,warn` after | Catches errors that don't surface in the DOM |
| What happened over a long / flaky / reload-spanning run | `logs start` … `logs tail --grep`/`--since` | Durable one-line-per-record timeline of page + workers; `console` loses it on idle shutdown |
| Layout/visual of a specific element | `screenshot --crop "<element>"` | ~1.6k tokens (1 tile) — crops to bounding box, massive token win |
| Layout, spacing, full-window visual regression | `screenshot --scale 0.5` | The only tool that sees pixels — but expensive (~6k tokens), use last |
| Canvas/WebGL scene contents | `scene --diff` | DOM is empty for canvas apps |
| What DOM nodes changed after an interaction | `dom --diff` | Returns only `+`/`-` lines; much cheaper than re-reading the full tree |

When two tools could answer the same question, prefer the one higher up the table. A common mistake is screenshotting to check "is the count = 5?" when `eval "store.counter"` returns the number directly for ~50 tokens.

## Verification Workflow

### Execution discipline (read first, every run)

A run can produce one of three outcomes per step: **pass**, **fail**, **requires_visual_review**. There is no fourth bucket called "actually fine, here's why". A failed `Expected:` line is FAIL.

These heuristics catch real bugs. Skipping them is how recipes silently pass while bugs sit in plain sight in the same data:

1. **A failed `Expected:` is FAIL.** If output disagrees with the expected line, mark `fail` and continue. Do not edit the expected line. Do not invent prose explanations inline ("label reuse", "convention", "recipe arithmetic off"). Justifications belong in the bug report after the run, never in the per-step log.

2. **UI-vs-model mismatch is the bug, not noise.** When a count or hierarchy check returns `match: false`:
   - Default hypothesis: the UI renderer is wrong.
   - Before considering "the filter matched something extra in some side panel", query bounding boxes and ancestor chains of the matched elements. Two matches at the same x-coordinate in adjacent y rows = sibling rows in one list = renderer bug.
   - Do not dismiss DOM/model divergence with "scene-graph is the source of truth". The model is one representation; the bug may live in the gap between model and UI.

3. **Defensive eval reads.** Every `node.field` read (e.g. `transform.x`, `transform.width`) must be sentinel-checked before being used in arithmetic. A renamed field silently returns `NaN`/`null`, which fail-passes downstream comparisons. Add `isFinite(value)` / `value !== undefined` guards inline.

4. **No hardcoded literal IDs.** If a recipe contains hardcoded node-ID prefixes that don't match the current scene, the entire recipe degrades to no-op without errors. Verify at least one expected ID exists; if not, derive IDs by role at runtime and proceed with the corrected lookup. Flag the recipe as needing an ID-refresh fix.

5. **Reload checkpoint is not optional.** If the recipe has a `## Round-Trip Checkpoint` or `## Invariants` section mentioning reload/save/persistence — run it. If it does not, but the feature mutated persisted structure — run one anyway: `agent-view eval "location.reload()"`, wait for the app to come back, re-read the structural signature, diff. Drift is a real bug, not a "fixed-up on save".

6. **Recipe-stated invariants run first or fail closed.** If the recipe has an `## Invariants` section, execute those steps before the action-specific evidence commands. A failed invariant is FAIL for that invariant *and* a flag on the rest of the run — keep running the remaining steps, tag them as "trust-impaired until invariant restored".

7. **Never claim a `window.*` API is missing without `eval`.** Before reporting "API not exposed" / "global X doesn't exist" / "the host doesn't expose Y", you MUST run `agent-view eval "typeof window.X"` and report the literal result (`"undefined"` / `"object"` / `"function"`). DOM scraping cannot answer this question — globals are not in the AX tree. If `eval` returns `"undefined"`, the API really is absent from the main world; if it returns anything else, the API is reachable and your earlier conclusion was wrong. No exceptions, no "I checked the source code instead".

### Recipe Execution Mode (when a recipe file exists)

If the developer points you at a `.claude/verify-recipes/<slug>.md` file, or one is discoverable via `ls .claude/verify-recipes/`, execute it inline yourself — **no subagent**.

1. `Read` the recipe.
2. If it has a `## Repro Steps` section, follow them — log in, navigate, set up data — using `agent-view` commands. Modern recipes (0.6+) may have `## Manual Preconditions` / `## Bringup` / `## Machine Preconditions` instead; treat those as documentation describing the expected state and execute the actions inline. There is no formal DSL — read what the section says and do it.
3. Resolve the window id once with `agent-view discover` if you need `--window`.
4. **If the recipe has an `## Invariants` section, run those steps first.** A failed invariant is FAIL — record it, then continue to evidence commands but tag subsequent results as "trust-impaired" until the invariant is restored.
5. Run each `## Evidence Commands` subsection in order. Compare output to its `Expected:` line. Mark each as `pass` / `fail` / `requires_visual_review`. **Follow the Execution discipline above** — particularly rules 1 and 2.
6. After 2–3 consecutive failures, stop and flag the recipe as likely stale. Distinguish "recipe stale" (hardcoded IDs no longer match) from "feature broken" (invariants violated on a current scene).
7. Run `## Regression Checks`.
8. **Run the round-trip checkpoint** (discipline rule 5) — either the recipe's section or, if absent and the feature is persistent, an ad-hoc reload check.
9. If a `## Design Conformance` section is present, run the inline workflow below.
10. Report a tight summary: passed / failed / visual-review counts plus one-liner per failure, and **any invariant violations called out separately**. Don't paste raw stdout unless asked.

### Ad-hoc Mode (standalone)

After making code changes:

1. **Determine affected areas** from git diff
2. **Ensure app is running**: `agent-view launch` or `agent-view discover`
3. **Inspect DOM**: `agent-view dom --filter "<area>" --depth 2` — check structure matches expectations
4. **Interact if needed**: `agent-view click`/`fill` → `agent-view dom --filter` to verify state changed
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

### Design Conformance (inline)

When a recipe contains a `## Design Conformance` table — `(label, screenshot command, expected reference path)` rows — execute it yourself, no subagent.

For each row:
1. Run the screenshot command (capture the saved file path from stdout).
2. `Read` both the captured image and the `expected_path`. If `expected_path` doesn't exist or is unreadable, mark the pair `skipped (expected_missing)` and move on.
3. Compare visually for: layout (relative position, alignment), sizing, color (dominant color family), typography (weight/size broadly), content presence (anything missing or extra), decorations (borders, shadows, dashed/solid lines, icons).
4. Report each pair as `match` / `minor_mismatch` / `major_mismatch` with a one-sentence deviation. Major = missing/wrong component, broken layout, wrong color family, wrong text content. Minor = <10px spacing drift, slight color shade, small decoration difference.

Tolerance default: a designer's code-review level — flag what they'd notice, ignore anti-aliasing noise. Don't speculate about CSS causes — describe what looks different and let the parent / user decide.

## Resilience

- **Stale refs:** After HMR, navigation, or state change — re-run `dom` for fresh refs before interacting
- **Element not found:** Wait 2s, retry once (render delay after HMR). If still missing — report FAIL
- **CDP disconnect:** Run `agent-view discover` to check. If no windows — `agent-view launch` (auto-starts Electron/Browser/Tauri). On `PORT_CONFLICT` — surface PID/process and ask user.
- **`CDP_TIMEOUT` error:** the command hit the server-side deadline; cached CDP sessions for that port were dropped, so retry once. Repeated timeouts mean the app's DevTools endpoint is wedged — restart the app.
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
| `agent-view dom --filter "row" --count` | Single integer answer — zero tree tokens |
| `agent-view dom --filter X --depth 2` | Narrow tree to relevant subtree, cap depth |
| `agent-view screenshot --scale 0.5` | ~3× fewer vision tokens (4 tiles) |
| `agent-view screenshot --scale 0.25` | ~12× fewer vision tokens (1 tile, ~1.6k tokens) |
| `agent-view screenshot --crop "<element>"` | ~12× fewer in best case (1 tile) — crops to element bounding box |
| DOM/eval-first: screenshot only for final visual confirm | Eliminates most screenshot calls |

**Default rule**: if the answer is a value → `eval`; if the answer is "is element X visible/correct?" → `agent-view dom --filter`; if you need pixels for a specific section → `screenshot --crop "<element>"` (one tile); only call `screenshot --scale 0.5` for full-window visual proof.
