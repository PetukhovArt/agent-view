# agent-view — Domain Glossary

Stable vocabulary for code, tests, RFCs, and PRs. Written in ubiquitous-language style: every term that appears in code, recipes, or user-facing skills should appear here, and vice versa.

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
- **Watch expression** — JS source string polled at fixed interval; differences across snapshots emitted as RFC 6902 JSON-Patch ops. Not a separate session — runs over an existing `RuntimeSession`.
- **Ref** — opaque session-scoped integer printed by `dom`/`scene` next to each node (`[ref=N]`). Stable until the next AX-tree mutation (`click`, `fill`, navigation). Consumed by `click`, `fill`, `drag`, and `screenshot --crop`.

## Config

- **`allowEval`** — boolean config flag. When `false` (or missing) the server refuses any `eval` request with a friendly pointer to docs. Required because the local socket already authenticates via token; this flag is the project-owner opt-in for arbitrary JS execution. Also gates `watch`.
- **`consoleBufferSize`** — per-target ring capacity (default 500).
- **`consoleTargets`** — target type allowlist that `console` auto-attaches to on first call (default `["page", "shared_worker", "service_worker"]`).

## Verify Recipe

A markdown file at `.claude/verify-recipes/<slug>.md` that defines an end-to-end verification of a feature or fix. Authored by the `verify-recipe` skill, executed inline by the `verify` skill — no subagents.

### Recipe sections

- **`## Repro Steps`** — exact starting state and the actions that trigger the behavior under test. Free-form prose. Read by the executing agent and performed inline via `agent-view` commands.
- **`## Narrowed Signal`** — single sentence stating the one measurable thing that proves the feature works. Documentary.
- **`## Evidence Commands`** — numbered subsections, each containing one or more `agent-view` commands plus an `Expected:` line. The verification body.
- **`## Positive-Case Assertions`** — checklist mirror of Evidence Commands' `Expected:` lines. Documentary.
- **`## Regression Checks`** — adjacent flows that must still work. Documentary or runnable.
- **`## Design Conformance`** *(optional)* — table of `(label, screenshot command, expected reference image path)` pairs. Executed inline by the `verify` skill: it captures each screenshot, opens both actual and expected via `Read`, and reports `match` / `minor_mismatch` / `major_mismatch` per row.
- **`## Anti-patterns avoided`** — recipe-specific notes. Documentary.

## Plugin: skills

- **`verify` skill** — main-agent-facing entry point. Reads recipe (when one exists), performs `Repro Steps` setup, runs Evidence Commands inline against the live app, compares to `Expected:`, reports pass/fail. Handles Design Conformance inline. Also supports ad-hoc and scenario-from-plan modes.
- **`verify-recipe` skill** — interviews the developer (feature, symptom, edge cases, optional design refs), drafts a recipe in canonical format, saves to `.claude/verify-recipes/<slug>.md`. Authoring only — does not execute.

## What this glossary deliberately omits

- Implementation details (cache invalidation triggers, IPC framing, AX tree merging, runner internal polling cadence) — those live in code.
- Per-runtime branches (Electron vs Tauri vs Browser) — those are adapter concerns, not domain.
- CLI flag inventory — that's `agent-view --help` and `README.md`.
