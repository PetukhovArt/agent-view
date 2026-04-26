# agent-view — Domain Glossary

Stable vocabulary for code, tests, RFCs, and PRs. Written in ubiquitous-language style: every term that appears in code should appear here, and vice versa.

## CDP layer

- **Target** — any CDP target enumerated by `CDP.List`. Has `id`, `type ∈ {page, iframe, shared_worker, service_worker, worker, ...}`, `title`, `url`. Modeled as `TargetInfo` in `src/cdp/types.ts`.
- **Page Target** — a target whose `type` is `page` or `iframe`. Supports the `Page`, `DOM`, `Accessibility`, `Runtime`, `Console`, `Log` domains.
- **Runtime-Only Target** — a target whose `type` is `shared_worker`, `service_worker`, or `worker`. Supports only `Runtime`, `Console`, `Log`. Cannot be screenshotted, cannot have its DOM walked.
- **Unsupported Target** — `browser`, `worklet`, `auction_worklet`. Refused at the server boundary before any connect attempt.

## Sessions

- **Runtime Session** (`RuntimeSession`) — a connected CDP client scoped to one target, exposing only domain-agnostic operations: `evaluate`, console event subscription, `close`. Created by `connectToRuntime`.
- **Page Session** (`PageSession`) — a `RuntimeSession` plus page-only operations (`getAccessibilityTree`, `queryAXTree`, `captureScreenshot`, `clickByNodeId`, `clickAtPosition`, `fillByNodeId`). Created by `connectToPage`. `PageSession extends RuntimeSession`, so anything that accepts a `RuntimeSession` also accepts a page session.
- **Connection cache** — server-owned `Map<port:targetId, CachedSession>` that reuses sessions across requests within the idle window. Each entry is kind-tagged (`page` | `runtime`).

## CLI surface

- **Window** — user-facing alias for Page Target. Kept as the `--window` CLI flag for back-compat. Resolves only to page targets.
- **Target** (CLI sense) — same as the CDP definition above. Selected by `--target <id>` (or substring match against title/URL). Resolves to any connectable target — page, iframe, or runtime-only.
- **Eval expression** — JavaScript source string passed to `Runtime.evaluate`. Always wrapped in `returnByValue: true` unless explicitly opted out.
- **Console Stream** — server-owned multi-target subscription that normalizes `Runtime.consoleAPICalled` and `Log.entryAdded` into a single `ConsoleMessage` shape, buffered per target in a ring of bounded capacity.

## Config

- **`allowEval`** — boolean config flag. When `false` (or missing) the server refuses any `eval` request with a friendly pointer to docs. Required because the local socket already authenticates via token; this flag is the project-owner opt-in for arbitrary JS execution.
- **`consoleBufferSize`** — per-target ring capacity (default 500).
- **`consoleTargets`** — target type allowlist that `console` auto-attaches to on first call (default `["page", "shared_worker", "service_worker"]`).

## What this glossary deliberately omits

- Implementation details (cache invalidation triggers, IPC framing, AX tree merging) — those live in code.
- Per-runtime branches (Electron vs Tauri vs Browser) — those are adapter concerns, not domain.
