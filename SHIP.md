# Roadmap

Planned features to research and ship, ordered by priority (highest first). Each item lists the concrete payoff — why it's worth building, not just what it is.

---

## High priority

### 1. `agent-view watch <expr>` — reactive state debugger
Polls or Proxy-traps a runtime expression, emits a diff log of every change with timestamp and (where possible) stack trace. Works against Vue refs, Pinia, Redux, Zustand, MobX.
**Payoff:** answers "the click did X but the state shows Y — what happened in between?". Today only the final state is visible; this is the biggest agent-debugging gap that screenshots and DOM dumps can't cover. Also enables time-based assertions (`wait until store.status === 'ready'`) that currently require bash polling.

### 2. `agent-view skill init` — project-aware skill generation
Reads `package.json`, entry files, and `agent-view.config.json`; emits a project-specific section for `verify/SKILL.md` with real store paths, worker target ids, and common UI surfaces.
**Payoff:** every new project today re-discovers the same patterns. With this the skill ships pre-tuned per repo, agent onboarding drops from minutes to seconds, and `eval` calls hit the right path on the first try instead of probing.

### 3. `agent-view mcp` — MCP server mode
Wraps the existing CLI as an MCP server. No core changes; one new transport.
**Payoff:** Cursor, Cline, Aider, Continue, and any MCP-aware agent get the same verification loop for free. Single library, every agent.

### 4. `agent-view network` — Network domain capture
Captures CDP `Network` events: request/response timeline, headers, response body via `Network.getResponseBody`. Separate RFC.
**Payoff:** closes the largest remaining verify-flow blind spot. Catches silent 404s, CORS blocks, missing auth headers, slow XHRs that never surface in console.

### 5. `agent-view eval --main` — Electron main-process eval
Connects to Electron's Node inspector port (`--inspect=PORT`) and evaluates in the main process.
**Payoff:** today agent-view sees only the renderer. IPC handlers, fs operations, native modules, and app lifecycle are invisible. This closes the one Electron gap Playwright has and we don't.

---

## Medium priority

### 6. `dom --compact`
Strips indentation and merges single-child chains onto one line.
**Payoff:** ~40–60% fewer output tokens on deep trees with no information loss. Direct savings on every `dom` call.

### 7. `screenshot --crop <filter>`
Crops the screenshot to the bounding box of a matched element.
**Payoff:** capture one tile (~1.6k vision tokens) instead of twelve (~19k). Reuses the targeting pattern the rest of the CLI already uses.

### 8. `dom --count`
Returns only the element count for a filter, no tree.
**Payoff:** "does this section have N rows?" answered with one number instead of a subtree. Pairs naturally with assertion-style verification.

### 9. `console --follow --until <pattern>`
Stream breaks early when a log matches the pattern.
**Payoff:** today `--follow` always burns the full `--timeout`. With `--until`, common waits ("until app emits 'ready'") finish in milliseconds instead of seconds.

### 10. State preset helpers — `eval --pinia` / `--redux` / `--zustand`
Bundled extract scripts in `scripts/state-readers/` that resolve the store root automatically.
**Payoff:** removes per-project guesswork ("where is the Pinia root mounted?"). Tradeoff: framework-version coupling — scripts must stay thin.

### 11. `dom --max-lines <n>`
Hard output budget with a summary tail (`… 47 more nodes`).
**Payoff:** predictable token ceiling per call. Prevents accidental huge dumps when a filter matches more than expected.

### 12. `scene --compact`
Same single-line / merged-children output mode as `dom --compact`, for the scene graph.
**Payoff:** parity with `dom`. Same savings on canvas/WebGL apps.

---

## Low priority / research

### 13. `console --target <substring>`
Fuzzy target resolve, mirroring what `eval --target` already does.
**Payoff:** consistency — today the asymmetry between `eval` and `console` target matching is a footgun.

### 14. `dom --diff`
Emits only nodes that changed since the last `dom` call (like `scene --diff`).
**Payoff:** post-interaction "what changed?" without re-reading the whole tree. Requires snapshotting formatted output, not just AX state.

### 15. WebP for scaled screenshots
WebP at q=80 is ~30% smaller than JPEG.
**Payoff:** faster server→CLI transfer and smaller temp files. Vision token count is unchanged (pixel-based), so this is I/O only — useful, not transformative.

### 16. Cache-hit annotation
Prepend `[cache]` to `dom` output served from the AX cache.
**Payoff:** signal for the agent (or human) to decide between trusting the cached tree vs invalidating.

### 17. `snap --scale` passthrough
Forward `--scale` through to the screenshot half of `snap`.
**Payoff:** consistency between `screenshot --scale` and `snap`.

### 18. Plain browser mode
Drop the launch step; attach to an existing Chromium tab.
**Payoff:** one tool for desktop and web instead of two. Low differentiation — Chrome DevTools MCP already covers this — only worth doing if a real user asks.

### 19. CesiumJS support
Scene-graph reader for Cesium-based apps, parallel to the PixiJS reader.
**Payoff:** unblocks Cesium-stack projects. Low priority until a project actually needs it.

---

## Out of scope

- **Test-runner features** — no `expect()`, no retry harness, no codegen. Use Playwright for those.
- **Tracing / video recording** — serves human reviewers, not agent loops.
- **Playwright-Electron parity** — we borrow only what closes real agent-verification gaps (main-process eval, IPC inspection). Everything else is out of scope.
