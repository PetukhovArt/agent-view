# agent-view

**Give your AI agent eyes and hands for complex desktop apps verification**

AI coding agents can write code, run tests, and read logs — but they can't *see* what the app actually looks like. Without visual verification, an agent is essentially **coding blind** — builds pass, tests are green, but the login form is broken, the button is off-screen, or the modal never appears.

agent-view bridges that gap: it connects to any Chromium-based desktop app via Chrome DevTools Protocol and lets the agent inspect, interact, and verify.

Built for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), but works with any AI agent or automation pipeline that can call CLI commands.

## 5-minute quickstart

1. **[Install](#install--update)** — `npm i -g @petukhovart/agent-view` plus the Claude Code plugin.
2. **[Enable CDP](#enabling-cdp) in your app** — one line in your Electron `main.ts`, gated to dev builds.
3. **`agent-view init`** in your project — then add `"allowEval": true` to the generated `agent-view.config.json`.
4. **`agent-view launch`** — starts your app and waits for CDP readiness.
5. **In Claude Code:** describe what you want verified — see [example prompts](#recommended-workflow-with-claude-code).

Each step links to the full explanation below.

## What it does

- **DOM accessibility tree** with ref IDs — compact, LLM-friendly, with text/role filters; `--compact` merges single-child chains for 40–60% fewer tokens, `--count` returns just the match count, `--max-lines` caps output, `--diff` emits only what changed since the last call
- **Screenshots** — full-res PNG, scaled WebP (~3–12× fewer vision tokens), or `--crop <filter>` to a single element bounding box
- **Interaction** — click, fill, and drag by ref or coordinates; works with Vue/React/native frameworks
- **JS state via `eval`** — read store contents, computed values, async results without scraping the DOM
- **Reactive state via `watch`** — stream JSON-patch diffs of any expression (store, ref, computed) until a condition is met
- **Console capture** — `console.log/warn/error` per page and per worker, with level/since filters and `--follow --until <pattern>` for early exit on a matching log
- **Worker access** — SharedWorker, ServiceWorker, dedicated Worker visible alongside pages; fuzzy `--target` resolution everywhere (id → title → URL)
- **Canvas / WebGL scene graph** — PixiJS today, engine-pluggable; `--compact` mirrors the DOM mode
- **Design-conformance verification** — pair screenshot commands with local design references (Figma export, hand-off
  PNGs, any image on disk) inside a verify-recipe; the `verify` skill compares screenshots against the references inline

## Why CLI, not MCP?

Most alternatives in this space are MCP servers with 30+ tool definitions loaded into context on every session. That burns tokens before the agent even starts working.

agent-view is a CLI. One Bash call, compact text output, zero schema overhead. The accessibility tree comes back as plain text — not wrapped in JSON-RPC with metadata. For an agent that runs dozens of verification steps, the token savings add up fast.

And CLI works everywhere — Claude Code, Copilot, Codex, custom pipelines, CI. No MCP client required.

## Install & Update

### Claude Code (recommended)

Two steps — both required:

```bash
# 1. Install the plugin — adds two skills: verify (run checks against a live app) and verify-recipe (author a verification plan)
/plugin marketplace add PetukhovArt/agent-view
/plugin install agent-view@agent-view

# 2. Install the CLI — the skill calls these binaries; the plugin doesn't bundle them
npm install -g @petukhovart/agent-view
```

The plugin ships two skills. **`verify`** executes visual and runtime checks against a running app. **`verify-recipe`** generates a `.claude/verify-recipes/<slug>.md` file — a disciplined, cheapest-first command sequence for a feature or bugfix — that you or any AI agent can run later. Trigger it with phrases like "write a verify-recipe for the login fix" or "generate a verification plan for this feature".

For the canonical author-once / re-run flow, see [Recommended workflow with Claude Code](#recommended-workflow-with-claude-code) below.

Verify:

```bash
agent-view --version   # 0.5.0+
```

### Standalone CLI (any other agent, CI, or scripting)

```bash
npm install -g @petukhovart/agent-view
```

Everything works from this alone — `agent-view dom`, `screenshot`, `eval`, etc. Skip the plugin step.

### Update

```bash
# Update the CLI to the latest version
npm update -g @petukhovart/agent-view

# Update the Claude Code plugin (refreshes skills from the marketplace)
/plugin marketplace update agent-view
/plugin install agent-view@agent-view   # re-run to pick up new skill versions
```

The two are independent — bump the CLI when a new release ships features (see `CHANGELOG.md`), bump the plugin when skill instructions change.

## Enabling CDP

agent-view talks to your app over Chrome DevTools Protocol. Your app must be launched with a debugging port open.

### Recommended: in code (reliable, works with any build tool)

Add to your Electron main process, **before `app.whenReady()`** (top of `main.ts`/`main.js`, right after the `electron` import — switches set after the app is ready are ignored):

```js
import { app } from 'electron';

app.commandLine.appendSwitch('remote-debugging-port', '9876');
```

> Any free port works — `9876` is just an example. Avoid `9222` (Chrome's own default remote-debugging port) to prevent
> collisions when Chrome is open.

**Production safety:** an open CDP port in a signed/notarized build is a remote-code-execution surface. Gate it on `!app.isPackaged` so it only opens in dev:

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

## Quick start with Claude Code (Prompting)

Assumes the plugin and CLI are installed (see [Install & Update](#install--update)) and CDP is enabled in your app (
see [Enabling CDP](#enabling-cdp)).

**1. Generate config once:**

```bash
cd your-electron-project
agent-view init   # writes agent-view.config.json — auto-detects runtime, port, launch script, webgl engine
```

Then open `agent-view.config.json` and add `"allowEval": true` if you want recipes to use `eval` / `watch` (most do —
store/state assertions are 100× cheaper than DOM scraping). Off by default for security; see [Config](#config) for the
full field list.

**2. Start your app:**

```bash
agent-view launch   # uses the `launch` command from config, waits for CDP readiness, idempotent
```

(Or start it yourself with `npm run dev` etc. — `launch` is just a convenience.)

**3. From Claude Code, ask for a verification:**

```text
The "Save" button on the Settings dialog stayed enabled while a save was in flight.
I added a `saving` ref bound to :disabled. Verify it works:
- after click, button must be disabled until network completes
- no console errors in the flow
```

Claude picks the `verify` skill, runs a handful of `eval` / `dom --filter` / `console` calls against your live app,
reports what passed and what failed. No CLI commands typed by you.

For a repeatable, multi-step verification (PRD/plan-driven, with optional design-mockup conformance),
see [Recommended workflow with Claude Code](#recommended-workflow-with-claude-code) — it's the canonical 3-phase prompt
flow this package is built around.

### Without Claude Code (manual CLI / CI / other agents)

If you're scripting from CI or another agent, the CLI works standalone:

```bash
agent-view discover                  # List all windows (JSON)
agent-view dom --filter "Submit"     # Accessibility tree, filtered, with ref IDs
agent-view fill 3 "hello@example.com"
agent-view click 7
agent-view eval "store.state.user.role"
agent-view screenshot --crop "Sidebar" --scale 0.5
```

Full surface in [Commands](#commands) below.

## Recommended workflow with Claude Code

A repeatable, token-efficient flow for "I shipped a feature/fix → confirm it actually works visually and at runtime". Two phases, each driven by a focused prompt.

### Phase 1 — Author the verification plan (once)

Generate the recipe **once**, from a PRD / plan file / Jira ticket / commit range. The recipe is reusable — re-run after every iteration on the same feature.

```text
Generate a verify-recipe for the changes in commits <hash1>..<hash2>.
Source plan: .claude/plans/2026-04-27-login-redirect.md
Original symptom: after login, redirect went to /home instead of /dashboard.

Design references (if any):
- /abs/path/figma-exports/login-success.png    → label "post-login dashboard"
- /abs/path/figma-exports/error-state.png      → label "invalid creds error"
```

What this triggers: the `verify-recipe` skill interviews you (if more context needed), then writes a `.claude/verify-recipes/<slug>.md` with `Repro Steps`, `Evidence Commands` (cheapest-first: `eval` / `dom --filter` before `screenshot`), `Regression Checks`, and — if you provided design refs — a `Design Conformance` table mapping screenshot commands to expected reference images.

**Tip:** if you implemented from a Figma file via the `figma-implement-design` skill, it likely already saved exports somewhere on disk — pass those paths. agent-view does NOT fetch from Figma URLs; provide local files only.

### Phase 2 — Run the recipe

```text
Run the verify-recipe at .claude/verify-recipes/<slug>.md.
```

What this triggers: the `verify` skill reads the recipe, performs the `Repro Steps` setup, runs each `Evidence Command` against the live app, compares output to the recipe's `Expected:` lines, and reports pass/fail per step. If the recipe has a `Design Conformance` section, the same skill captures the screenshots, opens both actual and expected images, and reports `match` / `minor_mismatch` / `major_mismatch` per pair — all inline, in the same conversation.

When something fails, ask the main agent to fix and re-run only the affected steps:

```text
Step 4 failed (zone filter not mutating store). Fix and re-run that step plus step 7.
```

### One-shot prompt (when there's no plan to convert)

For small fixes where you don't want a persistent recipe file:

```text
The "Save" button on the Settings dialog wasn't disabling while a save was in flight.
I added a `saving` ref and bound it to :disabled. Verify it works:
- after click, button must be disabled until network completes
- no console errors
- visual: button greys out (compare to /abs/path/saving-state.png if one is provided)
```

Claude will pick the right skill (usually `verify` ad-hoc mode), run a handful of `eval` / `dom --filter` / `console` calls, and only screenshot if the visual claim needs it.

### Anti-patterns to avoid

- "Just verify the feature" with no plan or symptom — the recipe author can't pick the cheapest signal without knowing what "works" means. Give it the symptom that motivated the fix.
- Pasting Figma URLs and expecting agent-view to download them — it won't. Export the frames you care about to PNG first.
- Stuffing 50 assertions into one recipe — split per-feature. A recipe should run in <2 minutes and produce a report you can read in 30 seconds.

## How it works

```
CLI → TCP → Lazy Server → CDP → Your App
```

A background server connects to your app's CDP port, caches sessions, and auto-shuts down after 5 minutes of inactivity. No manual `connect` step — the server starts on first CLI call and handles connection lifecycle automatically.

## Config

Running `agent-view init` in your project root generates `agent-view.config.json`. Minimal form:

```json
{
  "runtime": "electron",
  "port": 9876,
  "launch": "npm run dev"
}
```

Full form with all optional fields:

```json
{
  "runtime": "electron",
  "port": 9876,
  "launch": "npm run dev",
  "allowEval": true,
  "webgl": {
    "engine": "pixi"
  },
  "consoleBufferSize": 500,
  "consoleTargets": ["page", "shared_worker", "service_worker"]
}
```

| Field               | Required | Description                                                                                               |
|---------------------|----------|-----------------------------------------------------------------------------------------------------------|
| `runtime`           | yes      | `"electron"`, `"tauri"`, or `"browser"`                                                                   |
| `port`              | yes      | CDP debugging port                                                                                        |
| `launch`            | no       | Command to start the app                                                                                  |
| `webgl.engine`      | no       | `"pixi"` (scene extractor architecture supports adding more engines)                                      |
| `allowEval`         | no       | `true` to enable `agent-view eval` and `watch`. Off by default — opt-in for arbitrary JS execution        |
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
agent-view dom --max-lines 200      # Hard line budget (refs for hidden nodes still stored)
agent-view dom --text               # Fall back to DOM textContent search when AX returns no match
agent-view dom --compact            # Merge single-child chains onto one line (saves ~40-60% tokens)
agent-view dom --count              # Return only the count of matching nodes (e.g. "5")
agent-view dom --filter "row" --count  # Count how many rows match
agent-view dom --diff               # Show only lines that changed since last call
```

When `--filter` is set, depth defaults to unlimited so deep matches aren't truncated.

`--count` skips tree formatting and ref-store mutations entirely — useful for assertions like "does this section have N rows?" without the token cost of a full tree dump.

`--max-lines <n>` caps the number of output lines. When the tree exceeds the budget, output is truncated after `n-1` lines and a summary tail `… M more nodes` is appended. Refs for all nodes — including those past the cutoff — are still registered in the ref store, so a follow-up `dom --filter` or `click <ref>` works without re-running.

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

Captures a screenshot, saves to temp dir, prints the file path. PNG by default; WebP (q=80) when `--scale` is set (JPEG fallback for older Chrome/Electron).

```bash
agent-view screenshot
agent-view screenshot --scale 0.5             # Half-res WebP (~3× fewer vision tokens)
agent-view screenshot --scale 0.25            # Quarter-res WebP (~12× fewer, 1 tile)
agent-view screenshot --crop "Sidebar"        # Crop to element bounding box (~12× fewer in best case)
agent-view screenshot --crop "Chart" --scale 0.5  # Crop + scale (stacks)
```

`--scale` accepts a factor in `(0, 1]`. CDP-side clip + WebP encode — recommended for agent loops where vision tokens dominate cost.

`--crop <filter>` resolves a DOM element by the same filter syntax as `dom --filter`, then crops the screenshot to its bounding box before encoding. One tile (~1.6k vision tokens) instead of twelve (~19k) in the best case. If the filter matches nothing a warning is emitted to stderr and the full window is captured instead. Combines naturally with `--scale`.

### `scene`

Reads the WebGL scene graph for canvas-based apps. Currently supports PixiJS via `window.__PIXI_DEVTOOLS__`.

```bash
agent-view scene                    # Full scene graph
agent-view scene --diff             # Changes since last call
agent-view scene --filter "player"  # Filter by name/type
agent-view scene --verbose          # Extended props (alpha, scale, bounds)
agent-view scene --compact          # Merge single-child chains onto one line
```

### `snap`

Combined DOM + scene graph in one call. Shows DOM always; scene section appears when a WebGL engine is detected. Pass `--scale` to also capture a screenshot and append it as a third section.

```bash
agent-view snap
agent-view snap --scale 0.5   # DOM + Scene + Screenshot (path written to tmp)
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
agent-view console --follow --until "ready"     # exit as soon as a message contains "ready"
agent-view console --follow --until "/error/i"  # exit on regex match (case-insensitive)
agent-view console --target IJ56KL              # restrict to one target (exact id)
agent-view console --target sync-worker         # restrict to one target (title/URL substring)
agent-view console --level error,warn           # level filter
agent-view console --since "2026-04-26T10:00:00Z"
agent-view console --clear                      # drop in-memory ring
```

`--until <pattern>` requires `--follow`. Exits as soon as a message matches the pattern (substring or `/regex/flags`). On timeout without match exits non-zero with `Timeout: pattern not seen in <N>s`.

`--target` resolves the same way as `eval --target`: exact id wins, then title substring, then URL substring. If no match is found, an error is returned.

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

## Performance

Built for tight `dom → click → dom` loops. Typical Electron app, ~200 AX nodes:

| Scenario                       | agent-view | Playwright (estimate) |
|--------------------------------|------------|-----------------------|
| `dom` cold fetch               | 2ms        | ~30–80ms              |
| `dom` warm (cache hit)         | 1ms        | ~30–80ms              |
| Full cycle `dom → click → dom` | 17ms       | ~75ms                 |

What makes it fast: 300ms AX-tree cache (invalidated on `click`/`fill`/navigation; cached responses prefixed with
`[cache]`), parallel CDP calls in `click`, `Accessibility.queryAXTree` for filter lookups, and a single persistent CDP
WebSocket reused across commands (no relay).

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
