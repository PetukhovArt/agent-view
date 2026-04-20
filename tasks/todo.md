# TODO: agent-view v0.2.0

## Task 1 — Benchmark harness
- [x] 1a: Create `bench/app/package.json` (Electron pinned, start script)
- [x] 1b: Create `bench/app/main.js` (BrowserWindow, CDP port 19222)
- [x] 1c: Create `bench/app/index.html` (~200 AX nodes, fixed structure)
- [x] 1d: Create `bench/run.ts` (7 scenarios, median+p95, baseline delta)
- [ ] 1e: Run baseline, commit `bench/baseline.json`  ← requires `cd bench/app && npm install` first
- [x] 1f: Add `bench/results.json` to `.gitignore`

## Task 2 — Opt B: Parallel click
- [ ] 2a: Refactor `clickByNodeId` in `transport.ts` (Promise.all + fire-and-forget)
- [ ] 2b: Create `src/cdp/transport.test.ts` (call order + coordinate tests)
- [ ] 2c: `pnpm test` — all tests green
- [ ] 2d: Run bench, verify `click_filter_cold` improved

## CHECKPOINT A
- [ ] All tests green
- [ ] Benchmark delta recorded
- [ ] Commit `perf: parallel CDP calls in clickByNodeId (Opt B)`

## Task 3 — Opt A: AX tree cache
- [ ] 3a: Create `src/cdp/ax-cache.ts` (AxTreeCache class, TTL=300ms)
- [ ] 3b: Create `src/cdp/ax-cache.test.ts` (TTL, invalidate, hit/miss)
- [ ] 3c: Update `transport.ts` — inject cache, wrap `getAccessibilityTree`, `Page.frameNavigated` listener
- [ ] 3d: Update `src/adapters/types.ts` — add `cache` param to `connect`
- [ ] 3e: Update `browser.ts`, `electron.ts`, `tauri.ts` — pass cache through
- [ ] 3f: Update `server.ts` — create `AxTreeCache` instance, pass to adapters, bust on `handleClick`/`handleFill`
- [ ] 3g: `pnpm test` — all tests green
- [ ] 3h: Run bench, verify `dom_warm` ≤ 20ms, `click_filter_warm` improved

## CHECKPOINT B
- [ ] All tests green
- [ ] `dom_warm` substantially lower than `dom_cold`
- [ ] Commit `perf: AX tree cache with 300ms TTL (Opt A)`

## Task 4 — Opt C: queryAXTree routing
- [ ] 4a: Add `queryAXTree` method to `CDPConnection` in `src/cdp/types.ts`
- [ ] 4b: Implement `queryAXTree` in `transport.ts` (with null-on-unavailable)
- [ ] 4c: Add per-connection `queryAXTreeAvailable` flag to transport
- [ ] 4d: Extract `parseFilter` function in `server.ts`
- [ ] 4e: Update `findByFilter` to route simple filters to `queryAXTree`
- [ ] 4f: Wire queryAXTree results into ref store (via `formatAccessibilityTree`)
- [ ] 4g: Create `src/server/server.test.ts` (parseFilter + routing tests)
- [ ] 4h: `pnpm test` — all tests green
- [ ] 4i: Run bench, verify `click_filter_cold` ≤ baseline × 0.5

## CHECKPOINT C
- [ ] All tests green
- [ ] `click_filter_cold` ≤ baseline × 0.5
- [ ] `click_filter_warm` ≤ cold × 0.3
- [ ] Commit `perf: queryAXTree for targeted filter lookups (Opt C)`

## Task 5 — Finalize
- [ ] 5a: Fill acceptance criteria table in `SPEC.md` with real numbers
- [ ] 5b: Bump `package.json` version to `0.2.0`
- [ ] 5c: Update `CHANGELOG.md`
- [ ] 5d: Update `.claude.current-stage.md`
- [ ] 5e: Final commit + `git tag v0.2.0`
