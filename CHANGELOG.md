# Changelog

All notable changes to this project will be documented in this file.

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
