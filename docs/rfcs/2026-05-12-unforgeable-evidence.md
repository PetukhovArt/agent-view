# RFC: Unforgeable evidence for verify runs

Status: Draft (design only — no implementation yet)
Date: 2026-05-12
Author: PetukhovArt

## Problem

`agent-view`-driven verification (`verify` / `verify-recipe` skills) produces evidence as free-form markdown citing DOM excerpts, screenshot paths, store values, console output. An external reader of `07-{k}-verification.md` — e.g. the `feature-workflow` P10 attestation, P8.5 conformance subagent, or a code reviewer — has no way to distinguish:

- evidence produced by a live CDP session against a running app
- evidence hand-written by an agent that skipped the verify step entirely

Observed failure mode (2026-05-11 grouping session): agent reported "796 tests green" + paraphrased DOM/state assertions, never invoked `agent-view`. The feature-workflow tripwire (`SLICING.md` step 0) can require the artifact file to exist but cannot prove the file's contents came from a real session.

## Goals

1. Each `agent-view` command in a verify run leaves a machine-checkable trace tying its output to a specific live CDP session.
2. A skill / external reader can verify the trace integrity in O(seconds) without re-running the recipe.
3. No reliance on cryptographic signing infrastructure — the trust anchor is "evidence whose internal consistency is hard to fabricate manually".
4. Backwards-compatible: existing recipes without trace data still execute.

Non-goals: defending against a malicious agent with file-system write access willing to invoke `agent-view` purely to forge a trace. Target is the *accidental* / *lazy* failure mode (agent skipping verify and writing plausible markdown), not adversarial.

## Proposed design

### Session manifest

Each `agent-view` server start (lazy server, already shuts down after 5min idle) writes a session manifest at `.agent-view/sessions/<session-id>.jsonl`. `<session-id>` = uuid v4 generated at server start.

Each CLI command appends one NDJSON line:

```json
{
  "ts_mono_ms": 12834,
  "ts_wall": "2026-05-12T10:14:23.451Z",
  "session_id": "8c2f...",
  "chrome_pid": 47821,
  "cdp_target_id": "IJ56KL...",
  "command": "eval",
  "args": ["store.state.user.role"],
  "exit_code": 0,
  "stdout_sha256": "ab12...",
  "stdout_bytes": 87,
  "artifact_path": null
}
```

For `screenshot`: `artifact_path` = absolute path; `stdout_sha256` = SHA-256 of the image file bytes (not stdout, which is just the path string).

For `dom` / `eval` / `watch` / `console`: `stdout_sha256` = SHA-256 of the actual stdout bytes the CLI emitted.

`ts_mono_ms` = `performance.now()` from session start. Strictly monotonic per session. Forging a plausible monotonic sequence across N commands requires actually running them in order.

### Recipe-bound runs

New CLI subcommand: `agent-view verify-run --recipe <path> [--out <path>]`.

- Generates a fresh `session_id` upfront.
- Executes each `## Evidence Commands` step of the recipe in order, appending to the session manifest.
- Writes `<recipe>-evidence.json` (or `--out`) containing:
  - Recipe SHA-256 (so the manifest is bound to a specific recipe version).
  - Session ID + start/end wall timestamps + Chrome PID.
  - For each step: index, the step's command, its manifest line, pass/fail/needs-eye verdict, expected vs actual one-line diff.
  - Total wall-clock duration.

This bundles the otherwise-scattered evidence into a single file the workflow can cite.

### Skill-side consumption

`verify-recipe` skill updates `Evidence` column requirements:

- Each AC row must cite a manifest line by `(session_id, step_index)` *or* an artifact path that appears in the manifest's `artifact_path`.
- Hand-paraphrased evidence ("DOM: tree-node[data-type='group'] present") is no longer qualifying without a manifest reference.

`feature-workflow` tripwire (`SLICING.md` step 0) updates to a mechanical check:

```bash
# 07-{k}-verification.md must reference an evidence.json whose:
# - recipe_sha256 matches 07-{k}-verify-recipe.md
# - session_id resolves to a manifest with strictly-monotonic ts_mono_ms
# - chrome_pid was alive during the session window (best-effort via OS — optional)
```

### Why this is hard to forge accidentally

Three internal consistency properties an agent would have to fake all at once:

1. **Monotonic timestamps across N steps.** Easy to fake one line, harder to fake N plausibly-spaced lines that match command costs (a screenshot takes ~200ms, an eval ~30ms).
2. **stdout_sha256 matches the cited evidence excerpt.** Agent can't paraphrase the DOM and also produce a matching hash without actually running the command.
3. **Recipe SHA in evidence file matches recipe-on-disk.** Catches the case where the agent edits the recipe after forging evidence.

None of these are crypto-strength. A determined agent can run `agent-view` purely to forge — but that's no longer the failure mode; that's deliberate fraud and a different problem.

## Scope of v0.5.1 (proposed)

- Session manifest writing (read-side opt-in via `--manifest <path>` initially).
- `agent-view verify-run --recipe` subcommand (new).
- Update `skills/verify/SKILL.md` and `skills/verify-recipe/SKILL.md` to cite manifest in `Evidence`.

Out of scope for v0.5.1 (later):
- OS-level Chrome-PID liveness check.
- Cross-session manifest aggregation.
- Skill in `feature-workflow` consuming the manifest mechanically.

## Open questions

1. Should manifest writing be on-by-default or opt-in via flag? On-by-default is what makes it useful for the no-corner-cutting goal, but writes to `.agent-view/` in every project that uses the CLI.
2. Should `verify-run` exit non-zero on any FAIL, or just write the evidence and exit 0? Workflow-driven runs want non-zero; ad-hoc runs may want 0.
3. Manifest cleanup policy — keep last N sessions, age-based, or `agent-view session prune`?
