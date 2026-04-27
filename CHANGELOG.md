# Changelog

## [0.8.0] - 2026-04-27

Adds idempotent bringup so recipes can drive the app from any starting state — auth screen, fresh shell, mid-state, already-ready — without manual setup. Cuts Manual Preconditions to ~zero for most features and makes recipes safe to re-run.

### Added — `## Bringup` section in recipes

Three precondition phases now: `## Manual Preconditions` (only what `agent-view` physically can't do), `## Bringup` (idempotent setup the runner executes itself), `## Machine Preconditions` (pure state queries that confirm bringup landed).

Each Bringup step has the form:
```markdown
### B<N>. <title>
- if `<state-eval>` is `<falsy criterion>`:
    <action command 1>
    <action command 2>
  wait for `<post-condition eval>` to be `<truthy criterion>`, timeout <Ns>
```

The runner always evaluates the IF first. If the system is already in the target state → skip the actions, advance. Otherwise → run actions in order, then poll the post-condition until truthy or timeout. Re-running a recipe when the app is ready costs ~3 seconds (only state-checks, zero actions).

### Added — `verify-runner` Phase 1

- Executes Bringup steps with separate budgets: `bringup_max_total_commands: 15`, `bringup_max_wall_time_seconds: 60`.
- New abort statuses: `bringup_failed` (post-condition didn't land — bringup spec wrong), `bringup_timeout`, `bringup_budget_exhausted`.
- Bringup snapshot screenshot (final unconditional `agent-view screenshot` step) is captured into the report so the user can see "where bringup left the app" if anything downstream fails.
- `mode: dry_run` now covers Bringup + Machine Preconditions + first Evidence Command — full validation that a freshly authored recipe is healthy end-to-end.

### Added — `verify-recipe` skill

- Interview reorganized into three blocks: A (what's verified), B (bringup — auth, modes, setup with programmatic-API preference), C (assertions, design refs).
- Bringup template auto-generated from interview answers. Skill prefers programmatic APIs over UI clicks and asks the developer for them explicitly.
- Credentials use env-var references (`$AGENTVIEW_PASSWORD`) by default. Skill warns when it sees a literal password in a Bringup command and offers to convert to env-var.
- Dry-run validation prompt now exercises the full bringup → preconditions → step-1 chain.

### Changed — `verify` skill

- Pre-flight no longer asks the user "is the app set up?" when Manual Preconditions is empty — bringup handles setup. Skill spawns runner immediately.
- Recipes auto-detected by format (0.6 / 0.7 / 0.8). Older recipes still run with format-warning caveats; failures are reported with appropriate context.
- New report status handling: `bringup_failed`, `bringup_budget_exhausted`, `bringup_timeout` map to recipe-author-error guidance ("re-author this Bringup step"), distinct from `precondition_failed` (bringup landed but state weird) and `cascading_failures` (Evidence stale).

### Changed — README

- New section: "Three-phase preconditions (0.8.0+)" explaining the Manual / Bringup / Machine split with the GIS recipe as worked example.
- Recommended workflow Phase 1 prompt updated: skill now asks for programmatic APIs and env-var names, not for manual setup steps.

### Migration

0.7.0 recipes still execute. The runner detects missing `## Bringup` and proceeds to Machine Preconditions. To benefit from idempotent bringup, regenerate the recipe via `verify-recipe` — the skill will interview for the bringup-relevant info you didn't provide before.

## [0.7.0] - 2026-04-27

Hardens the recipe execution loop. The 0.6.0 subagents could "flail" when a recipe step's command didn't match the expected output — burning tool calls to find missing UI elements. This release introduces hard budgets, a separation between manual and machine preconditions, and a dry-run mode so authoring can validate a recipe before a full run.

### Added — `verify-runner`

- **Hard budgets**: `max_tool_calls_per_step: 2`, `max_tool_calls_total: 30`, `max_consecutive_failures: 3`. Prevents runaway exploration when a recipe is stale or preconditions weren't met.
- **`no_exploration` rule**: the runner is now explicitly forbidden from running any Bash command not literally written in the recipe. If a step's output doesn't match `Expected:`, mark `failed` with the actual output and continue — investigation is the parent agent's job.
- **Two-phase execution**: Phase 1 runs `## Machine Preconditions` first; if any fail, the runner aborts with `precondition_failed`, echoes the `## Manual Preconditions` block back to the user, and skips the entire Evidence section. Phase 2 runs Evidence Commands only if Phase 1 passed.
- **`mode: dry_run`**: executes only Machine Preconditions + the first Evidence Command. Used by `verify-recipe` to validate a freshly authored recipe before committing to a full run.
- **Structured abort reasons** in the report: `cascading_failures`, `budget_exhausted`, `precondition_failed`, `malformed_recipe`.

### Added — `design-conformance-runner`

- Same budget/no-exploration discipline: `max_tool_calls_per_pair: 3`, `max_tool_calls_total: 20`. Prevents the same flailing failure mode for visual checks.

### Changed — `verify-recipe` skill

- **Recipe template now splits Repro Steps into `## Manual Preconditions` (human-readable, not executed) and `## Machine Preconditions` (runnable `agent-view` checks).** Every Manual Precondition should have a paired Machine Precondition that proves it took effect; gaps are surfaced during the interview.
- **Interview expanded** with two new questions: "UI mode requirements" (what view/mode must be active) and "State assertions for each manual step" (what JS expression proves the setup happened). Catches the common "I forgot to mention we need to be in map mode, not settings" failure mode at authoring time, not at runtime.
- **Dry-run validation step**: after saving the recipe, the skill offers to spawn `verify-runner` in `dry_run` mode against the live app to validate that preconditions are reachable and the first Evidence Command runs. Catches a stale recipe before it ships.

### Changed — `verify` skill

- **Pre-flight check**: before spawning the runner, the skill now reads the recipe, surfaces the Manual Preconditions to the user, and asks for confirmation that the app is set up that way. Refuses to spawn if the user says no.
- **Better failure handling**: `precondition_failed` reports are relayed verbatim with the Manual Preconditions block; `cascading_failures` / `budget_exhausted` are flagged as "recipe likely stale, update before retrying".
- Older 0.6.x recipes without a `## Machine Preconditions` section still run, but failures are flagged with a recipe-format caveat in the summary.

## [0.6.0] - 2026-04-27

### Added — bundled subagents

- `verify-runner` (Haiku) — executes a `.claude/verify-recipes/<slug>.md` recipe end-to-end and returns a compact JSON report. The `verify` skill now delegates recipe execution to this subagent so the main agent's context stays clean (~50k → ~2k tokens for a typical recipe).
- `design-conformance-runner` (Haiku) — compares pairs of (actual screenshot, expected design reference) and reports visual deviations against the mockup. Local image files only (Figma exports, hand-off PNGs, screenshots from disk) — no Figma URL fetching.

### Added — `verify-recipe` skill

- Optional **Design Conformance** section in generated recipes. The skill now asks for design reference paths during context-gathering and, if provided, emits a screenshot↔reference mapping table that `design-conformance-runner` consumes. Anti-pattern explicitly added: never invent design ref paths when the developer didn't supply them.

### Added — `verify` skill

- **Recipe Execution Mode**. When a recipe file is referenced (or auto-discovered in `.claude/verify-recipes/`), the skill spawns `verify-runner` instead of executing inline. If the recipe contains a Design Conformance section, `design-conformance-runner` is spawned in parallel and reports merged.

### Added — README workflow docs

- `5-minute quickstart` checklist at the top.
- `Quick start with Claude Code (Prompting)` — replaces the old CLI-only quickstart with a Claude Code-first flow, with raw CLI usage moved to a `Without Claude Code` fallback block.
- `Recommended workflow with Claude Code` — canonical 3-phase prompt flow (author recipe → run via Haiku subagent → iterate on failures), with one-shot prompt and anti-patterns sections.
- Removed the standalone `Output format` section (duplicated info already in `Commands`) and the duplicate login-flow CLI example.

### Internal

- Plugin manifest now ships `agents/` alongside `skills/`. Updated `package.json` `files` array accordingly.

## [0.5.0] - 2026-04-27

### Added — token-savers

- `agent-view dom --compact` — merge single-child chains onto one line (`group > section > button "Save" [ref=N]`). 40–60% fewer tokens on deep trees, refs preserved.
- `agent-view dom --count` — return only the count of matching nodes as a single integer line. Skips tree formatting and ref-store mutation entirely.
- `agent-view dom --max-lines <n>` — hard line budget with a `… N more nodes` summary tail. Refs for truncated nodes are still stored so they remain addressable.
- `agent-view dom --diff` — emits only `+`/`-` lines that changed since the last `dom` call for the same target. First call returns the full tree (no prior snapshot). Refs are normalised before comparison so monotonic ref growth doesn't mark every line as changed.
- `agent-view scene --compact` — same single-line / single-child-merge mode for the WebGL scene graph.

### Added — screenshots

- `agent-view screenshot --crop <filter>` — crop the screenshot to the bounding box of a matched element. Reuses the same filter syntax as `dom --filter`. Falls back to a full-window capture with a stderr warning when nothing matches.
- WebP encoding for scaled screenshots — when `--scale < 1`, captures at `format: 'webp', quality: 80` instead of JPEG. ~30% smaller files; transparent JPEG fallback when the runtime doesn't support WebP.

### Added — workflow

- `agent-view snap --scale <factor>` — `snap` now optionally captures a screenshot at the given scale and appends a `=== Screenshot ===` section with the file path.
- `agent-view console --follow --until <pattern>` — exit the follow stream as soon as a console message matches `<pattern>` (substring or `/regex/flags`). Avoids burning the full `--timeout` when the expected log arrives early.
- `agent-view console --target <substring>` — fuzzy resolve by id, then title, then URL substring (mirrors `eval --target`).
- `[cache]` annotation — first line of `dom` output is prefixed with `[cache]` when the AX tree was served from the in-process cache.

### Added — new marketplace SKILL

- New `verify-recipe` skill in the plugin (alongside `verify`). Triggers on phrases like "write verify recipe for X" / "generate verification plan for fix Y". Walks through the hard-debug methodology (REPRO → narrowed signal → cheapest-first command sequence) and emits `.claude/verify-recipes/<slug>.md`.

### Fixed

- `dom --diff` no longer reports the entire tree as changed when only refs differ between calls. Comparison now happens on a ref-normalised key while the emitted lines retain real refs.

### Internal

- `AxTreeCache` returns a `{ nodes, fromCache }` pair so the server can annotate hits.
- `findByFilter` reused by `screenshot --crop`.
- 211 unit tests passing.

## [0.4.0] - 2026-04-27

### Added

- `agent-view drag` — HTML5/pointer drag-and-drop via CDP `Input.dispatchMouseEvent`
  (`mousePressed` → N × `mouseMoved` → `mouseReleased`). Endpoints by ref or coordinates;
  flags `--from`, `--to`, `--from-pos`, `--to-pos`, `--steps`, `--button`, `--hold-ms`, `--window`.
  Closes #1.
- `PageSession.getBoxCenter` and `PageSession.dragBetweenPositions` on the CDP session API
- `agent-view watch <expression>` — reactive state debugger. Polls a JS expression at
  fixed interval, streams JSON-patch (RFC 6902) diffs to stdout. Flags `--interval`,
  `--duration`, `--max-changes`, `--until`, `--full`, `--json`, `--target`, `--window`.
  Gated by `"allowEval": true`. Closes long-standing "what changed between click and
  final state?" gap.
- `WatchSession` server-side handler with NDJSON streaming over the existing socket
  framing; idle-timer pause while streaming handlers are alive
- `fast-json-patch` dependency for diff computation
- `bench/app` — drag/drop section (handle + drop-zone in fixed-size absolute stage) for
  end-to-end exercise of the new `drag` command

## [0.3.0] - 2026-04-26

### Added

- `agent-view targets` — list every CDP target (pages, iframes, shared/service/dedicated workers)
  with optional `--type` filter and `--json` output
- `agent-view eval <expression>` — `Runtime.evaluate` against any connectable target. Gated by
  `"allowEval": true` in `agent-view.config.json`. Supports `--target`, `--window`, `--await`, `--json`
- `agent-view console` — buffered console stream from auto-attached targets; flags
  `--target`, `--follow --timeout`, `--level`, `--since`, `--clear`
- `screenshot --scale <0..1>` — CDP clip + JPEG encode; ~3–12× fewer Claude vision tokens
- `dom --text` — DOM `textContent` fallback when the AX tree returns no match
- `dom --filter` — depth now defaults to unlimited so deep matches aren't truncated
- `src/cdp/console-stream.ts` — `ConsoleStream` deep module: per-target ring buffer,
  level/since/target filtering, live subscription
- `CONTEXT.md` — domain glossary

### Changed

- `CDPConnection` removed in favour of `PageSession` (extends `RuntimeSession`). Page-only methods
  are now type-checked; passing a worker session into a page handler fails at compile time
- `connectToTarget` renamed to `connectToPage`; new `connectToRuntime` factory for worker targets
- `transport.listSupportedTargets` returns typed `TargetInfo[]` filtered to known types
- `AgentViewServer` handler dispatch uses a single registry instead of a `Set` + `switch`
- Connection cache is now kind-tagged (`page` | `runtime`) — page sessions transparently serve
  runtime requests because `PageSession extends RuntimeSession`

### Config

- `allowEval: boolean` — opt-in gate for `eval`. Required because the local socket is shared
  across CI agents that should not be able to run arbitrary JS by default
- `consoleBufferSize: number` (default 500) — per-target console ring capacity
- `consoleTargets: TargetType[]` — auto-attached target types for `console`
  (default: `["page", "shared_worker", "service_worker"]`)

## [0.2.0] - 2026-04-20

### Performance

- **Opt A — AX tree cache (300ms TTL):** `getAccessibilityTree` results are cached
  per connection with a 300ms TTL. Cache is invalidated on `click`, `fill`, and
  `Page.frameNavigated`. `dom_cold` improved 80%, `cycle_dom_click_dom` improved 37%.

- **Opt B — Parallel CDP calls in click:** `clickByNodeId` now runs `DOM.resolveNode`
  and `DOM.getBoxModel` in parallel (Batch 1), then scrolls (Batch 2), then fires
  both mouse events fire-and-forget (Batch 3). Reduces serial round-trips from 5 to 3.

- **Opt C — `Accessibility.queryAXTree` for targeted lookups:** Plain string and
  `role:name` filters use `Accessibility.queryAXTree` instead of fetching the full
  tree. Heuristic / regex filters (`~` prefix or special chars) still use full tree.
  Falls back gracefully on Electron < 11 (API unavailable).

### Added

- `bench/` — reproducible Electron benchmark harness with 7 scenarios and
  baseline/delta reporting (`npx tsx bench/run.ts`)
- `src/cdp/ax-cache.ts` — `AxTreeCache` class (TTL, invalidate, invalidateAll)
- `CDPConnection.queryAXTree` — targeted AX lookup by accessible name/role
- `parseFilter` — exported for tests; routes filter strings to fast or full-tree path

### Changed

- `connectToTarget` now requires an `AxTreeCache` parameter (injected by server)
- `RuntimeAdapter.connect` signature updated to accept `AxTreeCache`
- `findByFilter` uses `queryAXTree` for simple filters; returns "not found" immediately
  on empty queryAXTree result (no double-cost fallback)

## [0.1.0] - 2026-04-06

### Added
- CLI commands: `init`, `discover`, `dom`, `click`, `fill`, `screenshot`, `scene`, `snap`, `launch`, `wait`, `stop`
- Lazy TCP server with auto-shutdown after 5min idle
- CDP transport with IPv4/IPv6 dual-stack support
- Runtime adapters: Electron, Tauri (with internal target filtering), Browser
- PixiJS scene extractor with diff support
- DOM accessibility tree inspector with ref IDs and filtering
- Multiwindow support via `--window` flag
- Claude Code plugin with `verify` skill
- Security: TCP auth token, shell injection protection, buffer limits, args validation
