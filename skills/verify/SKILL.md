---
name: verify
description: "Visual and runtime verification of a running app over CDP. Use when user looking for: checking a UI change, reproducing a visual bug, driving interactions, or when any workflow phase must inspect the live app — DOM, screenshots, store and worker state, console errors, network calls, or which code an action actually reached, or mention: verify, agent-view, check UI, visual regression"
allowed-tools: Bash(agent-view *), Read
---

# Visual Verification with agent-view

`agent-view` inspects and drives a running desktop app over Chrome DevTools Protocol.

## Prerequisites

The target project needs `agent-view.config.json` in its root (`agent-view init` writes one) and CDP enabled in the
app — e.g. `--remote-debugging-port=9876` for Electron. Avoid `9222`: it is Chrome's own default and collides when
Chrome is open. The server is lazy: it starts on the first call and shuts down after 5 min idle.

## Commands

Flags, output contracts and per-command failure modes live in **[`references/commands.md`](references/commands.md)** —
read it before your first call in a session.

| Commands                             | What they cover                                                |
|--------------------------------------|----------------------------------------------------------------|
| `launch` `discover` `stop` `targets` | start the app; list windows and worker targets                 |
| `dom`                                | accessibility tree — filter, count, diff, depth cap            |
| `click` `fill` `drag`                | interaction by ref, by text, or by coordinate                  |
| `wait`                               | block until an element appears; non-zero on timeout            |
| `dialog` `upload`                    | JS modals and native file pickers                              |
| `screenshot`                         | full window, scaled, or cropped to one element                 |
| `eval` `watch`                       | state now / state trajectory over time (both need `allowEval`) |
| `console` `logs`                     | message ring buffer / durable file feed that survives reloads  |
| `network`                            | requests, headers, timing, bodies, WebSocket frames            |
| `coverage` `listeners`               | which functions ran; what handler is bound to a node           |
| `heap`                               | what grew between two heap snapshots, and what retains it      |
| `scene` `snap`                       | canvas / WebGL scene graph (only when `webgl` is configured)   |

Every command takes `--window <id|name>`. Refs (`[ref=N]`) are session-scoped — after HMR or navigation, re-run `dom`
for fresh ones.

## Picking the right tool

Verifications cost very different amounts. Pick the cheapest tool that can actually answer the question:

| The question is about…                                           | Use                                                          | Why                                                                                         |
|------------------------------------------------------------------|--------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| Element existence / text / role                                  | `dom --filter`                                               | Cheapest, structured, no vision tokens                                                      |
| Count of matching elements                                       | `dom --filter X --count`                                     | Single integer, no tree output, no ref mutations                                            |
| App state, store contents, computed values                       | `eval "expr"`                                                | DOM doesn't expose JS state; reading the tree to infer it is wasteful and unreliable        |
| Does `window.X` / a globally-exposed API exist?                  | `eval "typeof window.X"`                                     | DOM doesn't show JS globals; only authoritative check                                       |
| An element that has not rendered yet                             | `wait --filter "<text>"`                                     | Exits on appearance and non-zero on timeout — a real gate, unlike a fixed pause             |
| State *trajectory* — what changed during/after an action         | `watch "expr" --until …` or `--max-changes 1`                | `eval` shows the final snapshot only; `watch` shows the diffs in order                      |
| Worker logic (SharedWorker / ServiceWorker)                      | `eval --target <name>`                                       | Workers have no DOM at all                                                                  |
| Did the last action throw or warn?                               | `console --clear` before, `console --level error,warn` after | Catches errors that don't surface in the DOM                                                |
| Did an expected API call fire, and with what status?             | `network --clear` before, `network --url "<glob>"` after     | Captures eagerly from launch; the DOM shows the result, not the call                        |
| What happened over a long / flaky / reload-spanning run          | `logs start` … `logs tail --grep`/`--since`                  | Durable one-line-per-record timeline of page + workers; `console` loses it on idle shutdown |
| Layout/visual of a specific element                              | `screenshot --crop "<element>"`                              | ~1.6k tokens (1 tile) — crops to bounding box, massive token win                            |
| Layout, spacing, full-window visual regression                   | `screenshot --scale 0.5`                                     | The only tool that sees pixels — but expensive (~6k tokens), use last                       |
| Canvas/WebGL scene contents                                      | `scene --diff`                                               | DOM is empty for canvas apps                                                                |
| What DOM nodes changed after an interaction                      | `dom --diff`                                                 | Returns only `+`/`-` lines; much cheaper than re-reading the full tree                      |
| Selecting a file for an input that exists in the DOM             | `upload --selector`                                          | No picker opens at all; works on hidden inputs, which have no ref                           |
| Selecting a file when the input appears only mid-click           | `dialog arm --file` then `click`                             | The only way — the input does not exist before the click and is gone after                  |
| Does any user action reach this code?                            | `coverage --clear` before, `coverage --file X` after         | The only tool that answers it; a diff cannot                                                |
| What handler is bound to this element, and where is it declared? | `listeners --filter "<text>"`                                | Gives `file:line` without reading the source                                                |
| Does repeating this action leak memory, and what holds it?       | `heap take` → act ×10 → `heap take` → `heap diff`            | The only tool that sees the heap; method in [`references/memory-leaks.md`](references/memory-leaks.md) |
| The window stopped responding after a click                      | `dialog`                                                     | Shows whether a modal was answered, and what the app was told                               |

When two tools could answer the same question, prefer the one higher up the table.

## Execution discipline (read first, every run)

A run produces one of three outcomes per step: **pass**, **fail**, **requires_visual_review**. There is no fourth bucket
called "actually fine, here's why". A failed `Expected:` line is FAIL.

**How to run the commands themselves:**

- **Never discard output.** No `>/dev/null`, no `2>&1` to nowhere, no `| head -1` on a command whose failure you have
  not yet read. Every agent-view command prints either the evidence or the reason it failed; a suppressed `click` that
  matched nothing looks exactly like a successful one.
- **Chain with `&&`, not newlines.** Newline-separated commands keep running after a failure, so a
  broken first step is followed by three steps acting on the wrong state. `&&` stops at the first
  non-zero exit.
- **One action, then one check.** `click` is not evidence. The evidence is the `dom --diff`,
  `dom --filter … --count`, `eval`, or `console --level error` you run after it. Three clicks in a row with no check
  between them prove nothing about any of them.
- **Never sleep for a fixed time.** No `sleep`, no `timeout`, no `ping -n N 127.0.0.1` as a delay (agents reach for
  `ping` when the harness blocks `sleep` — the same mistake in worse clothing). A fixed pause is either too short, and
  you assert against a half-rendered UI, or too long, and you burn wall-clock on every step. There is a condition-based
  wait for every kind of signal:

  | You are waiting for… | Use |
    |---|---|
  | An element to render | `wait --filter "<text>"` |
  | A store/state value | `watch "<expr>" --until "<expr>"` |
  | A log line | `console --follow --until "<pattern>"` |
  | A request to fire | `network --follow --until "<url>"` |

  If none of these fits, poll `dom --filter X --count` with an explicit attempt cap and report how many attempts it
  took.
- **Call the `agent-view` binary.** Install it once in the target project (`pnpm add -D @petukhovart/agent-view`, or
  your package manager's equivalent) and call
  `agent-view …` / `pnpm exec agent-view …`. Prefixing every call with `npx <package>` re-resolves the package on each
  invocation, and in permission-gated harnesses each call then needs a fresh approval prompt.

These heuristics catch real bugs. Skipping them is how a run silently passes while the bug sits in plain sight in the
same data:

1. **A failed expectation is FAIL.** If output disagrees with what the step expected, mark `fail` and continue. Do not
   soften the expectation. Do not invent prose explanations inline ("label reuse",
   "convention", "arithmetic off"). Justifications belong in the bug report after the run, never in the per-step log.

2. **UI-vs-model mismatch is the bug, not noise.** When a count or hierarchy check returns
   `match: false`, the default hypothesis is that the UI renderer is wrong. Before reaching for "the filter matched
   something extra in a side panel", query the bounding boxes and ancestor chains of the matched elements — two matches
   at the same x in adjacent y rows are sibling rows in one list, i.e. a renderer bug. The model is one representation,
   not the source of truth; the bug may live in the gap between model and UI.

3. **Defensive eval reads.** Sentinel-check every `node.field` read (`transform.x`,
   `transform.width`) before using it in arithmetic. A renamed field silently returns `NaN`/`null`, which fail-passes
   downstream comparisons. Add `isFinite(value)` / `value !== undefined` guards inline.

4. **No hardcoded literal IDs.** A hardcoded node-ID prefix that no longer matches the current scene degrades the whole
   check to a silent no-op. Verify at least one expected ID exists; if not, derive IDs by role at runtime, proceed with
   the corrected lookup, and say the plan needs an ID refresh.

5. **Reload checkpoint is not optional.** If the feature mutated persisted structure, run one:
   `agent-view eval "location.reload()"`, wait for the app to come back, re-read the structural signature, diff. Drift
   is a real bug, not a "fixed-up on save".

6. **Invariants run first or fail closed.** When the plan states invariants, execute those steps before the
   action-specific checks. A failed invariant is FAIL for that invariant *and* a flag on the rest of the run — keep
   running the remaining steps, tagged "trust-impaired until invariant restored".

7. **Never claim a `window.*` API is missing without `eval`.** Before reporting "API not exposed" /
   "global X doesn't exist" / "the host doesn't expose Y", run `agent-view eval "typeof window.X"`
   and report the literal result (`"undefined"` / `"object"` / `"function"`). DOM scraping cannot answer this — globals
   are not in the AX tree. If it returns `"undefined"` the API really is absent from the main world; anything else means
   the API is reachable and your earlier conclusion was wrong. No exceptions, no "I checked the source code instead".

## Verification Workflow

Run the whole thing inline — **no subagent**. Resolve the window id once with `agent-view discover`
if you need `--window`.

### Ad-hoc mode (standalone)

After making code changes:

1. **Determine affected areas** from `git diff` — every changed file that renders or drives UI needs at least one check.
2. **Ensure the app is running**: `agent-view launch` (or `agent-view discover`).
3. **Inspect DOM**: `agent-view dom --filter "<area>" --depth 2` — structure matches expectations.
4. **Interact**: `agent-view click`/`fill` → `agent-view dom --filter` to verify the state changed.
5. **For canvas apps**: `agent-view scene --diff`.
6. **For non-DOM truth** (store, computed values, worker state): `agent-view eval`.
7. **Before claiming code is unreachable**: `agent-view coverage --clear` → the action →
   `agent-view coverage --file "<file>"`. Reading the diff is not evidence either way; an empty result narrows the claim
   to "this action does not reach it".
8. **After any interaction that could fail silently**: `agent-view console --level error` — catches uncaught exceptions,
   network failures, framework warnings.
9. **Screenshot last, for visual confirm only**: `agent-view screenshot --scale 0.5`.

### Scenario mode (from a plan)

When UI scenarios are pre-generated (e.g. a plan file with a `## UI Scenarios` section): read the steps, resolve each
symbolic `$var` via `agent-view dom --filter "<text>" --depth 3` to a ref, execute the steps in order, and verify each
expected outcome with `dom --filter`. Screenshot only on FAIL and at the end of an E2E scenario, never per step.

### Reporting

One line per step, so the report stays machine-readable:

```
<step label> | pass | fail | requires_visual_review — <evidence command and its result>
```

Close with passed / failed / visual-review counts, and call out invariant violations separately. Do not paste raw stdout
unless asked.

**Design conformance** — when you are handed `(label, screenshot command, expected reference path)`
rows, follow [`references/design-conformance.md`](references/design-conformance.md).

## Resilience

- **Element not found:** `agent-view wait --filter "<text>" --timeout 5` covers the render delay after HMR. If it times
  out — report FAIL.
- **Stale refs:** re-run `dom` after HMR, navigation, or a state change before interacting again.
- **CDP disconnect:** `agent-view discover` to check. If no windows — `agent-view launch`. On
  `PORT_CONFLICT` the CLI reports the owning PID and process name; surface it and ask the user to free the port. Never
  kill a foreign process from this skill.
- **`CDP_TIMEOUT`:** the command hit the server-side deadline and cached sessions for that port were dropped, so retry
  once. Repeated timeouts mean the app's DevTools endpoint is wedged — restart it.
- **Retry budget: 2 per command**, then SKIP the step with a warning. Two covers a transient CDP drop; a third repeat
  means the app or the plan is wrong, not the call. After two or three consecutive failures, stop and distinguish "the
  plan is stale" (hardcoded IDs no longer match the UI) from "the feature is broken" (invariants violated on a current
  scene) — they need opposite fixes.

## Token Optimization

Vision tokens dominate cost: a full-res screenshot is ≈19k tokens (1920×1080, 12 tiles), `--scale 0.5`
≈6k (4 tiles), `--scale 0.25` and `--crop` ≈1.6k (1 tile). A text answer is ~50. So `--depth` and
`--filter` on `dom`, and `--count` where a number is the whole answer, cost near nothing by comparison.

**Default rule**: the answer is a value → `eval`; the answer is "is element X visible/correct?" →
`dom --filter`; you need pixels for one section → `screenshot --crop "<element>"`; only call
`screenshot --scale 0.5` for full-window visual proof.
