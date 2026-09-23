# agent-view command reference

Every command accepts `--window <id|name>`. Output is plain text, except `discover` (JSON) and
`screenshot` (a file path). Refs (`[ref=N]`) and req handles (`[req=N]`) are reallocated on every
listing call — always expand from the most recent one.

## Contents

- [Discovery & launch](#discovery--launch) — `launch`, `discover`, `stop`
- [DOM inspection](#dom-inspection) — `dom`
- [Interaction](#interaction) — `click`, `fill`, `drag`
- [Modals & file pickers](#modals--file-pickers-dialog-upload) — `dialog`, `upload`
- [Waiting](#waiting-wait) — `wait`
- [Screenshots](#screenshots) — `screenshot`
- [Runtime state](#runtime-state-eval) — `eval`
- [Reactive state](#reactive-state-watch) — `watch`
- [Console](#console-console) — `console`
- [Log feed](#log-feed-logs) — `logs`
- [Network](#network-network) — `network`
- [Reachability](#reachability-coverage-listeners) — `coverage`, `listeners`
- [Memory](#memory-heap) — `heap`
- [Targets](#targets-targets) — `targets`
- [Scene / canvas / WebGL](#scene--canvas--webgl-only-when-webgl-is-configured-in-agent-viewconfigjson) — `scene`, `snap`

### Discovery & Launch
```bash
agent-view launch                      # Start app from config, wait for CDP readiness (all runtimes incl. Tauri)
agent-view discover                    # List windows (JSON) — get window IDs
agent-view stop                        # Stop the lazy server
```

**Port conflict**: if the configured port is held by a non-CDP process (e.g. a stray webpack-dev on the same port), `agent-view launch` exits non-zero with `code: PORT_CONFLICT` and reports the owning PID/process name.

**Tauri**: launch works the same as Electron, but the wait timeout is 10 min (cargo builds are slow). A port conflict on the Tauri devUrl port is almost always a parallel browser-dev.

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

**Test ids.** A node carrying a test id prints it: `button "Save" [testid=save-btn] [ref=12]`. An
unnamed wrapper that carries one is printed too (`generic [testid=email] [ref=6]`), because
component libraries put the id on the wrapper. The attribute is `testIdAttribute` from
`agent-view.config.json`; without it `data-testid`, `data-test-id`, `data-test`, `data-qa` and
`data-cy` are all read. A test id survives HMR, navigation and text changes; a ref does not. Once
`dom` has shown a test id, address the element with `--testid` (below). Limit: an element absent
from the AX tree prints no line. An inline `<span data-testid>` holding only text prints as its
`StaticText`, without the id. `--testid` still finds it.

### Interaction
```bash
agent-view click <ref>                  # Click element by ref from dom output
agent-view click --filter "Save"        # Find element by text and click
agent-view click --pos 100,200          # Click by coordinates — CANVAS ONLY, see below
agent-view click <ref> --double         # Double-click (fires dblclick handlers); works with --filter / --pos too
agent-view click <ref> --right          # Right-click (fires contextmenu); works with --filter / --pos too
agent-view click --testid save-btn      # By test id (see "Test ids" above)
agent-view click --selector "tr:nth-child(3) button"  # By CSS selector
agent-view fill <ref> "text"            # Type into input field
agent-view fill --testid email "a@b.c"  # A test id on a wrapper resolves to the input/textarea inside
agent-view drag --from <ref> --to <ref>          # Drag element to another element by ref
agent-view drag --from-pos 50,80 --to-pos 200,300  # Drag by coordinates (for canvas / Pixi)
agent-view drag --from <ref> --to <ref> --steps 25 --hold-ms 60  # Smoother movement, longer hold
agent-view drag --from-pos 385,303 --to-pos 1250,589 --cancel  # HTML5: dragCancel instead of drop
agent-view drag --from-pos 385,303 --to-pos 1250,589 --html5   # Fail unless an HTML5 drag started
```

`drag` presses and moves via CDP; if Chromium starts an HTML5 drag (`draggable=true`) it takes it
over with `Input.dispatchDragEvent` and drops with the app's real `dataTransfer`, otherwise it is a
plain pointer drag. The first output line says which: `via html5 drop` followed by one line per
MIME type (`application/json: "..."`) — check the payload is the app's, not a text selection — or
`via pointer` with a warning when no HTML5 drag started. Start HTML5 drags on a cell without a
control: an input/select/button under the cursor swallows `dragstart`. Endpoints can mix
ref and coordinate (e.g. `--from <ref> --to-pos 400,300`). For canvas/Pixi targets always use
`--from-pos`/`--to-pos` — derive the centroid via `agent-view eval` from the scene graph.
Refs are resolved fresh on each call, so window resizes between snapshots are tolerated.
Increase `--steps` for handlers using `globalpointermove` so intermediate frames are not skipped.

`--testid` / `--selector` act on the **first visible** match; hidden copies (`v-show`, a closed
popover) are skipped. When several match, the output says so — `Clicked testid "row" (first visible
of 3)` — and the address is too broad: narrow it, e.g. a `--selector` with `:nth-child`. Exit 1 with
`No element matches testid "x"` when nothing matches, and with `None of 2 element(s) matching
testid "x" is visible` when every match is hidden. Pass exactly one of `<ref>`, `--filter`,
`--testid`, `--selector`, `--pos`. `fill` exits 1 with `No input or textarea at or inside the
element` when the element holds no field.

**Coordinates are a last resort.** `--pos` / `--from-pos` / `--to-pos` exist for canvas and WebGL,
where no ref exists. On DOM, use `--testid` when `dom` shows one. Otherwise run
`dom --filter "<text>"` → take the `[ref=N]` → `click <ref>`, or `click --filter "<text>"` in one
step. A coordinate pair breaks on any layout
shift, scroll, zoom, or window resize, and it clicks whatever now sits at that point — silently.
If you reach for `--pos` on a DOM element, first say why the ref was not usable.

### Modals & file pickers (`dialog`, `upload`)

A modal that agent-view cannot answer stops a run dead: the window looks frozen, every
later command times out, and nothing says why. Two kinds, handled differently.

**JS modals — `alert` / `confirm` / `prompt` / `beforeunload` — are answered for you.**
Nothing to set up. While agent-view is attached these never block the page: the default
standing answer is *dismiss*, and each one is recorded. `agent-view dialog` is the
reliable place to read that record; the console feed carries the same line
(`[agent-view] confirm auto-dismissed: <message>`) but only from the moment console
attaches, so a modal answered before your first `console` call reaches `dialog` alone.

```bash
agent-view dialog                      # standing answer + every modal this window has seen
agent-view dialog policy accept        # confirm() → true from now on
agent-view dialog policy accept --text "name"   # prompt() → "name"
agent-view dialog policy dismiss       # back to the default
agent-view dialog dismiss              # answer one that is open right now
agent-view dialog accept --text "x"    # …ditto, accepting
```

`dialog accept` / `dialog dismiss` exist for a modal that was already open **before**
agent-view attached — that one produced no event, so no policy applied to it.

**Native file pickers never open — you answer them in advance.** Which mechanism applies
depends on how the app opens the picker, and `dialog arm` sets up all of them at once,
so you do not have to know:

```bash
# The input already exists in the DOM (even hidden) — no picker at all, cheapest path
agent-view upload --selector "#file-input" --file ./fixtures/a.png
agent-view upload --selector "#imgs" --file ./a.png --file ./b.png   # multi-select
agent-view upload --ref 12 --file ./a.png                            # if the AX tree exposes it

# The input is created inside the click handler, or the app calls a native dialog API
agent-view dialog arm --file ./fixtures/a.png    # then click the button that opens it
agent-view dialog arm --cancel                   # act as if the user pressed Cancel
agent-view dialog disarm                         # let real pickers open again
```

Rules that actually bite:

- **Arm before the click.** A picker cannot be caught once it is open. `arm` is one-shot —
  it is spent by the first picker and interception turns itself off, so a later click
  opens a real OS dialog.
- **Click through `agent-view click`, never `eval "el.click()"`.** Chromium refuses to
  open a file picker without user activation, and an eval-driven click carries none: the
  picker is silently dropped and never intercepted.
- **Hidden inputs have no ref.** `display:none` / `v-show="false"` keeps them out of the
  AX tree, so `dom` never prints one. Use `--selector`. `upload` has no `--filter` on
  purpose: an accessible name lands on the label, not on the input behind it.
- **`beforeunload` is always dismissed**, whatever the policy — accepting it navigates
  away and loses the state you are checking.
- Paths are resolved against your cwd and must exist — CDP accepts a bad path silently and
  the app then reads an empty file.
- `agent-view dialog` after the fact shows what was intercepted and what was answered.

Known limits: `showOpenFilePicker()` (File System Access API) exposes no input to fill, so
it can only be cancelled. Electron does not implement `window.prompt` at all. Native
dialogs opened straight from an Electron **main** process (`dialog.showOpenDialog` behind
an IPC channel) are out of reach — CDP does not see the main process.

### Waiting (`wait`)

```bash
agent-view wait --filter "Saved"                    # until the text appears in the AX tree
agent-view wait --filter "Saved" --timeout 20       # max wait in seconds (default 10)
agent-view wait --filter "Row 5" --window "Main"    # specific window
agent-view wait --testid order-saved                # until an element with this test id is visible
agent-view wait --selector ".toast.success"         # until a selector match is visible
```

Exits as soon as the element appears; exits non-zero on timeout — so `&&` after it is a real gate.
A mounted but hidden match (`v-show`, `display:none`, `visibility:hidden`) does not end a
`--testid` / `--selector` wait. On timeout the error says whether nothing matched or every match
was hidden.

**Never sleep for a fixed time** — see the waiting-signal table in `SKILL.md`. If no condition-based
wait fits, poll `dom --filter X --count` with an explicit attempt cap and report the attempt count.


### Screenshots
```bash
agent-view screenshot --scale 0.5              # Recommended: half-res PNG (~3× fewer vision tokens)
agent-view screenshot --scale 0.5 --window <id>  # Specific window
agent-view screenshot --crop "Sidebar"         # Crop to element bounding box (~1.6k tokens — 12× win)
agent-view screenshot --crop "Chart" --scale 0.5  # Crop + scale (stacks)
agent-view screenshot --crop "Active bookings" --crop-up 1  # Crop the card, not just its heading
agent-view screenshot --testid order-card      # Crop to the element with this test id
agent-view screenshot --selector ".chart"      # Crop to the first visible selector match
agent-view screenshot                          # Full-res PNG (expensive: ~19k tokens at 1920×1080)
```

`--crop <filter>` resolves the element with the same filter syntax as `dom --filter`, then crops the screenshot to its bounding box. Prefer `--crop` over full-window screenshots whenever you only need to inspect a specific section. Falls back to full-window with a stderr warning if the filter matches nothing. `--testid` / `--selector` crop the same way and take `--crop-up`, but a miss exits 1 instead: an exact address that misses is a wrong address, and a full-window capture would spend ~19k tokens on it.

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

Feeds are scoped to the CDP port, so parallel worktrees each record their own app; give each one its own feed path (the default relative `.agent-view/console.log` already does, one per checkout).

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

### Reachability (`coverage`, `listeners`)

Use these before writing "no user action reaches this code" in a review. Reading a diff cannot prove reachability; running the app can.

**Only positive answers are cheap.** Proving a path exists costs one run of that path. Proving no path exists costs every path, so it is never bought. Both commands therefore treat an empty result as a valid answer with exit 0 — never as a failure — and neither ever proves unreachability.

`coverage` reports which functions ran since the last `--clear`, grouped by script URL:

```bash
agent-view coverage --clear                     # open the window: counters reset
agent-view coverage                             # what ran since --clear (and reset again)
agent-view coverage --file "OrderForm"          # scripts whose URL contains this
agent-view coverage --filter "onSubmit"         # function name or script URL contains this
agent-view coverage --count                     # just the number of executed functions
agent-view coverage --all                       # include node_modules / runtime / url-less scripts
agent-view coverage --max-lines 40              # cap the output, tail `… N more lines`
agent-view coverage --target sync-worker        # a worker's own window
```

Standard pattern for "does clicking Save reach the code I changed?" — `clear → act → check`:
```bash
agent-view coverage --clear \
  && agent-view click --filter "Save" \
  && agent-view coverage --file "OrderForm"     # expect the handler by name
```

**Every read is also a reset**, so two `coverage` calls in a row report different things — that is what makes one click attributable. Empty output is `(no code executed since --clear)`: it means *this* action did not reach the code, not that nothing can. Granularity is the function; unnamed functions print as `<anonymous>@<offset>`. Coverage lives in the V8 isolate, so a reload wipes it — `--clear` again after `location.reload()`. Reading before any `--clear` is an error telling you to run `--clear` first. `node_modules`, runtime bundles and url-less (`eval`'d) scripts are hidden unless `--all`.

`listeners` reports what is bound to one node and where each handler was declared:

```bash
agent-view listeners --filter "Save"    # node by accessible name, as in `click --filter`
agent-view listeners --ref 12           # node by ref from `dom`
agent-view listeners --selector "#save" # node by CSS — for nodes the AX tree never exposes
agent-view listeners --depth -1         # whole subtree (CDP depth; default 0)
```

Positions are 1-based (`file.vue:88:14`) and paste straight into a review comment. `(no listeners on this node)` means the node itself has none — the handler may still be delegated from an ancestor, so try `--depth -1` from a parent before concluding anything. An unresolvable script falls back to `scriptId:7:88:14`. Reach for `--selector` only when the node has no `[ref=N]` — hidden and `aria-hidden` elements never enter the AX tree.

### Memory (`heap`)

Named V8 heap snapshots, compared by class. The method (baseline → repeat the action ×10 → target → diff, then retainers) and how to read the output live in [`memory-leaks.md`](memory-leaks.md); this is the flag reference.

```bash
agent-view heap take --name baseline            # full GC, then snapshot; default names are s1, s2, …
agent-view heap take --name target -t worker    # a worker's own heap
agent-view heap diff                            # the two most recent snapshots
agent-view heap diff baseline target            # by name
agent-view heap diff --detached                 # detached DOM nodes only
agent-view heap diff --filter "OrderRow"        # class name contains this
agent-view heap summary                         # classes of the latest snapshot by size
agent-view heap retainers "Detached <div class=\"row\">"   # who holds the instances, one hop up
agent-view heap list                            # snapshots the server holds
agent-view heap clear                           # drop them
```

`take` prints one line: `Snapshot "target" (page:Orders): 184,203 nodes, 41.2 MB, 240 detached DOM nodes (960 KB)`. The JSON never leaves the server; only the class table and the graph are kept, and they go away when the server idles out (5 min) or on `clear`.

`diff` prints a header with the node, byte and detached deltas, then one row per class whose count or size changed, largest size growth first: `class  Δcount  Δsize  count`. Class names are V8's: JS objects by constructor (`OrderRowVM`), DOM nodes by tag and attributes (`<div class="row">`, `Detached <canvas>`), everything else by kind (`(string)`, `(closure)`, `(compiled code)`). Two snapshots with nothing changed print `(no class changed between "a" and "b")`, exit 0. `diff` before two snapshots exist is an error naming the recovery.

`retainers <class>` prints `retainer  instances` rows: `Array []` means the instances are elements of an `Array`, `RowRegistry .el` means they are the `.el` property of a `RowRegistry`. Distinct instances are counted, not edges; weak edges and the class's own instances are excluded. A class with no instances prints `(no instances of "X" in "s")`, exit 0. Quote the class name: it contains spaces and angle brackets.

`--max-lines <n>` caps `summary`, `diff` and `retainers` with the usual `… N more lines` tail.

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
