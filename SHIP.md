# Roadmap

Planned features to research and ship, ordered by priority (highest first). Each item lists the concrete payoff — why it's worth building, not just what it is.

---

## Done

### ✅ v0.5.0 token-savers + workflow polish (2026-04-27)
- `dom --compact` / `--count` / `--max-lines <n>` / `--diff` (with ref-normalised comparison)
- `scene --compact`
- `screenshot --crop <filter>` + WebP for scaled screenshots
- `snap --scale` passthrough
- `console --follow --until <pattern>` (early exit on match)
- `console --target <substring>` (fuzzy match, parity with `eval --target`)
- `[cache]` annotation on `dom` output served from AX cache
- New marketplace skill `verify-recipe` for authoring verification plans

### ✅ `agent-view watch <expr>` — reactive state debugger (Iteration 7, 2026-04-27)
Polls a JS expression at fixed interval, streams JSON-patch (RFC 6902) diffs to stdout.
Flags: `--interval`, `--duration`, `--max-changes`, `--until`, `--full`, `--json`, `--target`, `--window`.
Generic-expression MVP shipped; framework adapters (Pinia/Redux/Zustand/MobX/Vue ref) deferred to Iteration 2.
Spec: `docs/superpowers/specs/2026-04-27-watch-design.md`.

## High priority

### 1. `agent-view skill init` — project-aware skill generation
Reads `package.json`, entry files, and `agent-view.config.json`; emits a project-specific section for `verify/SKILL.md` with real store paths, worker target ids, and common UI surfaces.
**Payoff:** every new project today re-discovers the same patterns. With this the skill ships pre-tuned per repo, agent onboarding drops from minutes to seconds, and `eval` calls hit the right path on the first try instead of probing.

### 2. `agent-view mcp` — MCP server mode
Wraps the existing CLI as an MCP server. No core changes; one new transport.
**Payoff:** Cursor, Cline, Aider, Continue, and any MCP-aware agent get the same verification loop for free. Single library, every agent.

### 3. `agent-view network` — Network domain capture
Captures CDP `Network` events: request/response timeline, headers, response body via `Network.getResponseBody`. Separate RFC.
**Payoff:** closes the largest remaining verify-flow blind spot. Catches silent 404s, CORS blocks, missing auth headers, slow XHRs that never surface in console.

### 4. `agent-view eval --main` — Electron main-process eval
Connects to Electron's Node inspector port (`--inspect=PORT`) and evaluates in the main process.
**Payoff:** today agent-view sees only the renderer. IPC handlers, fs operations, native modules, and app lifecycle are invisible. This closes the one Electron gap Playwright has and we don't.

---

## Medium priority

### State preset helpers — `eval --pinia` / `--redux` / `--zustand`
Bundled extract scripts in `scripts/state-readers/` that resolve the store root automatically.
**Payoff:** removes per-project guesswork ("where is the Pinia root mounted?"). Tradeoff: framework-version coupling — scripts must stay thin.

---

## Low priority / research

### Plain browser mode
Drop the launch step; attach to an existing Chromium tab.
**Payoff:** one tool for desktop and web instead of two. Low differentiation — Chrome DevTools MCP already covers this — only worth doing if a real user asks.

### CesiumJS support
Scene-graph reader for Cesium-based apps, parallel to the PixiJS reader.
**Payoff:** unblocks Cesium-stack projects. Low priority until a project actually needs it.

---

## Out of scope

- **Test-runner features** — no `expect()`, no retry harness, no codegen. Use Playwright for those.
- **Tracing / video recording** — serves human reviewers, not agent loops.
- **Playwright-Electron parity** — we borrow only what closes real agent-verification gaps (main-process eval, IPC inspection). Everything else is out of scope.
