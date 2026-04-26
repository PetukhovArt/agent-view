# Changelog

## [Unreleased]

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
