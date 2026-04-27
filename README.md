# agent-view

**Give your AI agent eyes and hands for complex desktop apps verification**

AI coding agents can write code, run tests, and read logs — but they can't *see* what the app actually looks like. Without visual verification, an agent is essentially **coding blind** — builds pass, tests are green, but the login form is broken, the button is off-screen, or the modal never appears.

agent-view bridges that gap: it connects to any Chromium-based desktop app via Chrome DevTools Protocol and lets the agent inspect, interact, and verify.

Built for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), but works with any AI agent or automation pipeline that can call CLI commands.

## What it does

- **DOM accessibility tree** with ref IDs — compact, LLM-friendly, with text/role filters
- **Screenshots** — full-res PNG or scaled JPEG (~3–12× fewer vision tokens)
- **Interaction** — click, fill, and drag by ref or coordinates; works with Vue/React/native frameworks
- **JS state via `eval`** — read store contents, computed values, async results without scraping the DOM
- **Reactive state via `watch`** — stream JSON-patch diffs of any expression (store, ref, computed) until a condition is met
- **Console capture** — `console.log/warn/error` per page and per worker, with level/since filters
- **Worker access** — SharedWorker, ServiceWorker, dedicated Worker visible alongside pages
- **Canvas / WebGL scene graph** — PixiJS today, engine-pluggable

## Why CLI, not MCP?

Most alternatives in this space are MCP servers with 30+ tool definitions loaded into context on every session. That burns tokens before the agent even starts working.

agent-view is a CLI. One Bash call, compact text output, zero schema overhead. The accessibility tree comes back as plain text — not wrapped in JSON-RPC with metadata. For an agent that runs dozens of verification steps, the token savings add up fast.

And CLI works everywhere — Claude Code, Copilot, Codex, custom pipelines, CI. No MCP client required.

## The feedback loop

The real power isn't in individual commands — it's in the **loop**:

```
Code → Launch → See → Verify → Fix → See again
```

The agent writes code, then immediately checks what the user would see. If something's wrong, it fixes and re-checks — no human needed. This catches problems that builds and tests miss: CSS regressions, broken layouts, missing error messages, silent IPC failures.

## Install

### Claude Code (recommended)

Two steps — both required:

```bash
# 1. Install the plugin — adds the /agent-view:verify skill so Claude knows when and how to call agent-view
/plugin marketplace add PetukhovArt/agent-view
/plugin install agent-view@agent-view

# 2. Install the CLI — the skill calls these binaries; the plugin doesn't bundle them
npm install -g @petukhovart/agent-view
```

Verify:

```bash
agent-view --version   # 0.3.0+
```

### Standalone CLI (any other agent, CI, or scripting)

```bash
npm install -g @petukhovart/agent-view
```

Everything works from this alone — `agent-view dom`, `screenshot`, `eval`, etc. Skip the plugin step.

## Enabling CDP

agent-view talks to your app over Chrome DevTools Protocol. Your app must be launched with a debugging port open.

### Recommended: in code (reliable, works with any build tool)

Add to your Electron main process:

```js
app.commandLine.appendSwitch('remote-debugging-port', '9876');
```

> Any free port works — `9876` is just an example. Avoid `9222` (Chrome's own default remote-debugging port) to prevent
> collisions when Chrome is open.

For dev-only:

```js
if (!app.isPackaged) {
    app.commandLine.appendSwitch('remote-debugging-port', '9876');
}
```

### Alternative: via CLI flag (no code changes)

```bash
# Plain Electron
electron . --remote-debugging-port=9876

# electron-vite (note the -- to forward the flag past the build tool)
npx electron-vite dev -- --remote-debugging-port=9876
```

### Other runtimes

| Runtime              | Setup                                      |
|----------------------|--------------------------------------------|
| **Tauri**            | CDP via devtools configuration             |
| **Any Chromium app** | `--remote-debugging-port=9876` launch flag |

### Verify CDP is working

```bash
curl -s http://localhost:9876/json/version
```

If you see a JSON response with process info — you're good.

## Quick start

```bash
cd your-electron-project

# 1. Generate config (auto-detects runtime, port, launch command)
agent-view init

# 2. Start your app (or let agent-view do it)
agent-view launch

# 3. See what's on screen
agent-view discover          # List all windows
agent-view dom               # Accessibility tree with ref IDs
agent-view screenshot        # PNG screenshot

# 4. Interact
agent-view click 5           # Click element by ref
agent-view fill 3 "hello"    # Type into input

# 5. Verify the result
agent-view dom --filter "success"   # Check for expected element
agent-view screenshot               # Visual confirmation
```

## How it works

```
CLI → TCP → Lazy Server → CDP → Your App
```

A background server connects to your app's CDP port, caches sessions, and auto-shuts down after 5 minutes of inactivity. No manual `connect` step — the server starts on first CLI call and handles connection lifecycle automatically.

## Config

Running `agent-view init` in your project root generates `agent-view.config.json`:

```json
{
  "runtime": "electron",
  "port": 9876,
  "launch": "npm run dev"
}
```

| Field               | Required | Description                                                                                               |
|---------------------|----------|-----------------------------------------------------------------------------------------------------------|
| `runtime`           | yes      | `"electron"`, `"tauri"`, or `"browser"`                                                                   |
| `port`              | yes      | CDP debugging port                                                                                        |
| `launch`            | no       | Command to start the app                                                                                  |
| `webgl.engine`      | no       | `"pixi"` (scene extractor architecture supports adding more engines)                                      |
| `allowEval`         | no       | `true` to enable `agent-view eval`. Off by default — opt-in for arbitrary JS execution                    |
| `consoleBufferSize` | no       | Per-target console ring capacity. Default `500`                                                           |
| `consoleTargets`    | no       | Target types `agent-view console` auto-attaches to. Default `["page", "shared_worker", "service_worker"]` |

## Commands

Every command targeting a window accepts `--window <id|title-substring>` (IDs come from `discover`). Examples below omit
it for brevity.

### `init`

Auto-generates config by reading `package.json`.

### `discover`

Lists running app windows as JSON — window IDs, titles, URLs.

```bash
agent-view discover
```

### `dom`

Dumps the accessibility tree in compact text format. Each element gets a session ref ID for interaction.

```bash
agent-view dom
agent-view dom --filter "Submit"    # Filter by text/role
agent-view dom --depth 3            # Limit tree depth
agent-view dom --text               # Fall back to DOM textContent search when AX returns no match
agent-view dom --diff               # Show only lines that changed since last call
```

When `--filter` is set, depth defaults to unlimited so deep matches aren't truncated.

`--diff` computes a line-level diff against the previous `dom` call for the same target. The first call always returns the full tree (no prior snapshot). Subsequent calls emit only added (`+ `) and removed (`- `) lines. Returns `No changes` when the tree is identical.

### `click`

Clicks a DOM element by ref ID or coordinates.

```bash
agent-view click 5                  # By ref from dom output
agent-view click --pos 100,200      # By coordinates (for canvas)
```

### `fill`

Types text into an input. Uses native value setter + dispatches input/change events (works with Vue, React, and other frameworks).

```bash
agent-view fill 3 "hello@example.com"
```

### `drag`

HTML5 / pointer-driven drag-and-drop via CDP `Input.dispatchMouseEvent`
(`mousePressed` → N × `mouseMoved` → `mouseReleased`). Real mouse events, not
synthesized JS events — works with `vue-draggable-resizable`, `react-grid-layout`,
gridstack, kanban boards, file drop zones, map pin drags, resize handles.

```bash
agent-view drag --from 42 --to 88                   # ref → ref
agent-view drag --from-pos 86,792 --to-pos 640,200  # coord → coord (canvas, custom DnD)
agent-view drag --from 42 --to-pos 640,200          # mixed
agent-view drag --from 5 --to 9 --steps 20 --hold-ms 150
```

`--steps` (default 10) controls intermediate `mouseMoved` events so libraries
that throttle on movement deltas still see continuous motion. `--hold-ms`
inserts a pause between press and the first move (some libs require >100ms
for touch-style activation). `--button` accepts `left|right|middle`.

### `screenshot`

Captures a screenshot, saves to temp dir, prints the file path. PNG by default; JPEG when `--scale` is set.

```bash
agent-view screenshot
agent-view screenshot --scale 0.5             # Half-res JPEG (~3× fewer vision tokens)
agent-view screenshot --scale 0.25            # Quarter-res JPEG (~12× fewer, 1 tile)
```

`--scale` accepts a factor in `(0, 1]`. CDP-side clip + JPEG encode — recommended for agent loops where vision tokens dominate cost.

### `scene`

Reads the WebGL scene graph for canvas-based apps. Currently supports PixiJS via `window.__PIXI_DEVTOOLS__`.

```bash
agent-view scene                    # Full scene graph
agent-view scene --diff             # Changes since last call
agent-view scene --filter "player"  # Filter by name/type
agent-view scene --verbose          # Extended props (alpha, scale, bounds)
```

### `snap`

Combined DOM + scene graph in one call. Shows DOM always; scene section appears when a WebGL engine is detected.

```bash
agent-view snap
```

### `wait`

Waits for a DOM element matching the filter to appear. Useful after navigation or async operations.

```bash
agent-view wait --filter "Dashboard"              # Wait for element (default 10s)
agent-view wait --filter "Dashboard" --timeout 30 # Custom timeout in seconds
```

### `launch`

Starts the app using the `launch` command from config. Polls CDP until ready (60s timeout). Idempotent — skips if already running.

### `targets`

Lists every CDP target — pages, iframes, shared/service/dedicated workers. Use this when you need access to non-page targets (e.g. an Electron app with a `SharedWorker`).

```bash
agent-view targets                                       # all supported types
agent-view targets --type shared_worker,service_worker   # filter
agent-view targets --json                                # machine-readable
```

### `eval`

Runs `Runtime.evaluate` in any connectable target. **Requires `"allowEval": true` in `agent-view.config.json`** — the local socket is shared and this is the project-owner opt-in.

```bash
agent-view eval "document.title"
agent-view eval --target IJ56KL "self.constructor.name"           # by id (or title/url substring)
agent-view eval --window "Monitor 1" --await "fetch('/api/health').then(r => r.status)"
agent-view eval --json "({ buttons: document.querySelectorAll('button').length })"
```

Output is capped at 64 KB. Thrown exceptions and syntax errors propagate as non-zero exit with the CDP error message.

### `console`

Streams or dumps console output (`Runtime.consoleAPICalled` + `Log.entryAdded`) from auto-attached targets. Lazy: first call attaches matching targets, subsequent calls reuse them.

```bash
agent-view console                              # buffered messages since attach
agent-view console --follow --timeout 10        # stream for 10s
agent-view console --target IJ56KL              # restrict to one target
agent-view console --level error,warn           # level filter
agent-view console --since "2026-04-26T10:00:00Z"
agent-view console --clear                      # drop in-memory ring
```

Default attached target types: `page`, `shared_worker`, `service_worker`. Override with `consoleTargets` in config.

### `watch`

Polls a JS expression and streams JSON-patch (RFC 6902) diffs as it changes. Closes the "what changed between click and final state?" gap that screenshots and DOM dumps can't cover. **Requires `"allowEval": true`** (same gate as `eval`).

```bash
agent-view watch "store.cart.total"                          # 250ms poll, exits at 10 changes or 30s
agent-view watch "appState" --interval 100 --duration 60     # tighter cadence, longer window
agent-view watch "store.status" --until "store.status === 'ready'"  # wait-for assertion
agent-view watch "appState" --max-changes 1                  # snapshot first change after a click
agent-view watch "appState" --json                           # NDJSON, one frame per line
```

Output frames: `init` (baseline value), `diff` (RFC 6902 ops since last frame), `error`, `stop`. SIGINT exits cleanly. Snapshot size cap 256 KB — narrow the expression (e.g. `store.cart.items.length`) when watching large objects.

### `stop`

Stops the background lazy server.

## Output format

| Command                | Format     | Why                          |
|------------------------|------------|------------------------------|
| `dom`, `scene`, `snap` | Plain text | LLM-friendly, minimal tokens |
| `discover`             | JSON       | Machine-parseable            |
| `screenshot`           | File path  | Agent reads the image        |

## Performance

AI agents run dozens of `dom → click → dom` verification cycles per session. Every millisecond compounds. agent-view is
built specifically for this pattern.

### Benchmark results (Electron app, ~200 AX nodes)

| Scenario                       | v0.1.0 | v0.2.0+ | vs Playwright* |
|--------------------------------|--------|---------|----------------|
| `dom` cold fetch               | 10ms   | 2ms     | ~30–80ms       |
| `dom` warm (cache hit)         | 10ms   | 1ms     | ~30–80ms       |
| Full cycle `dom → click → dom` | 27ms   | 17ms    | ~75ms          |
| `click --filter "Save"`        | 12ms   | 17ms†   | ~15–30ms       |

\* *Playwright estimate based on architectural analysis — no published Electron-specific benchmarks exist*
† *queryAXTree has CDP overhead that exceeds the benefit on small DOMs; improves on large production DOMs (1000+ nodes)*

### What makes it fast

**AX tree cache (300ms TTL).** The single biggest win. When an agent calls `dom`, then immediately `click --filter`, the
second fetch hits the in-process cache instead of making a CDP round-trip. Cache is invalidated aggressively — busted on
every `click`, `fill`, or page navigation.

**Parallel CDP calls in click.** Previously 5 serial round-trips; now 3 parallel batches. `DOM.resolveNode` and
`DOM.getBoxModel` run concurrently, then mouse events fire back-to-back without waiting for each response (the same
approach Playwright uses internally).

**`Accessibility.queryAXTree` for targeted lookups.** Plain string filters (`click --filter "Save"`) and `role:name`
filters (`click --filter "button:Save"`) query the browser directly instead of fetching the full tree. Falls back
gracefully on older Electron versions.

**Raw CDP, no relay.** No Playwright client-server relay between your agent and the browser. The server process holds
the CDP WebSocket connection and reuses it across commands.

## Example: testing a login flow

```bash
# Start the app
agent-view launch

# See the login page
agent-view dom --filter "login"
# RootWebArea "My App"
#   textbox "Email" [ref=3]
#   textbox "Password" [ref=5]
#   button "Sign in" [ref=7]

# Fill credentials and submit
agent-view fill 3 "admin@example.com"
agent-view fill 5 "password123"
agent-view click 7

# Verify — did we land on the dashboard?
agent-view dom --depth 2
agent-view screenshot
```

## Troubleshooting

### CDP not responding

1. Check the port is listening: `curl -s http://localhost:9876/json/version`
2. For electron-vite: make sure you use `--` before the flag: `npx electron-vite dev -- --remote-debugging-port=9876`
3. Restart the app — HMR doesn't restart the main process

### Stale refs after HMR

After hot reload, refs from previous `dom` calls become invalid. Run `agent-view dom` again to get fresh refs.

### Launch timeout

Complex Electron apps may take >60s on cold start. If `agent-view launch` times out, start the app manually and use `agent-view discover` to verify.

## License

MIT
