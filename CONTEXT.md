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

A markdown file at `.claude/verify-recipes/<slug>.md` that defines an end-to-end verification of a feature or fix. Authored by the `verify-recipe` skill, executed by the `verify` skill (which delegates to subagents). Recipe format is canonical and parsed structurally — section headings have semantic meaning.

### Recipe sections

- **`## Manual Preconditions`** — actions only a human can perform (USB key auth, hardware setup, multi-machine state). The verify-runner does NOT execute these. Surfaced to the user before any subagent spawn. Usually empty in 0.8.0+ recipes.
- **`## Bringup`** — idempotent setup steps the verify-runner executes itself. Each step has the canonical shape:

  ```
  ### B<N>. <title>
  - if `<state-eval>` is `<falsy criterion>`:
      <action command 1>
      <action command 2>
    wait for `<post-condition eval>` to be `<truthy criterion>`, timeout <Ns>
  ```

  See **Bringup Step** below.
- **`## Machine Preconditions`** — pure state queries (`eval` / `dom --filter`). No actions, no clicks, no fills. Run after Bringup. Any falsy result aborts the run with `precondition_failed`.
- **`## Narrowed Signal`** — single sentence stating the one measurable thing that proves the feature works. Documentary — not parsed.
- **`## Evidence Commands`** — numbered subsections, each containing one or more `agent-view` commands plus an `Expected:` line. The verification body.
- **`## Positive-Case Assertions`** — checklist mirror of Evidence Commands' `Expected:` lines. Documentary.
- **`## Regression Checks`** — adjacent flows that must still work. Documentary or runnable.
- **`## Design Conformance`** *(optional)* — table of `(label, screenshot command, expected reference image path)` pairs consumed by `design-conformance-runner`.
- **`## Anti-patterns avoided`** — recipe-specific notes. Documentary.

### Bringup Step

A single conditional + idempotent setup unit:

- **IF condition** — `eval` or `dom --filter` returning a value compared against a falsy criterion (`is not "object"`, `is false`, `< 5000`).
- **Action commands** — list of `agent-view` commands run sequentially, only if IF condition triggered.
- **Post-condition** — second `eval` polled until truthy criterion holds, with a per-step timeout.
- **Outcome states** — `done` (triggered + post-condition landed), `skipped_already_ready` (IF condition was already in target state), `failed_post_condition` (actions ran but post-condition didn't land within timeout), `action_command_error` (action command itself crashed).

Idempotency invariant: re-running a Bringup step when the system is already in the target state must run zero action commands.

### Recipe statuses (in verify-runner JSON report)

- **`completed`** — all phases ran, all assertions evaluated.
- **`bringup_failed`** — a Bringup step's post-condition didn't land within timeout. Bringup spec is wrong (e.g., programmatic API doesn't exist, button text changed, criterion mistuned). Author error.
- **`bringup_timeout`** — wall-time budget exceeded across the entire Bringup phase.
- **`bringup_budget_exhausted`** — command-count budget exceeded across the entire Bringup phase.
- **`precondition_failed`** — Bringup landed (or was empty), but a Machine Precondition returned a falsy value. Real environment issue or incomplete bringup.
- **`cascading_failures`** — three Evidence steps failed back-to-back. Recipe Evidence likely stale (selectors/refs changed) or feature truly broken.
- **`budget_exhausted`** — Evidence command-count budget exceeded.
- **`malformed_recipe`** — recipe couldn't be parsed.

### Run modes

- **`full`** — Bringup → Machine Preconditions → all Evidence Commands.
- **`dry_run`** — Bringup → Machine Preconditions → first Evidence Command only. Used by `verify-recipe` after authoring, to validate the recipe is healthy before committing to a real run.

## Plugin: skills and subagents

- **`verify` skill** — main-agent-facing entry point. Reads recipe, surfaces Manual Preconditions to the user, resolves window id, spawns subagents, interprets reports.
- **`verify-recipe` skill** — interviews the developer (auth, programmatic APIs, env-var credentials, design refs), drafts a recipe in canonical format, optionally runs a dry-run validation.
- **`verify-runner`** — Haiku subagent. Disciplined recipe executor with hard budgets and a strict `no_exploration` rule. Never runs commands not in the recipe. Returns a single JSON report (see *Recipe statuses*).
- **`design-conformance-runner`** — Haiku subagent. Compares pairs of `(actual screenshot, expected reference image)` from a recipe's `## Design Conformance` section. Local image files only — no Figma URL fetching.

## What this glossary deliberately omits

- Implementation details (cache invalidation triggers, IPC framing, AX tree merging, runner internal polling cadence) — those live in code.
- Per-runtime branches (Electron vs Tauri vs Browser) — those are adapter concerns, not domain.
- CLI flag inventory — that's `agent-view --help` and `README.md`.
