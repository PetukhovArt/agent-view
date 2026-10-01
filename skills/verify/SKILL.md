---
name: verify
description: "Inspects and drives a running app over CDP with agent-view: DOM, screenshots, JS state, console, network, reached code, memory. Use to check a UI change, reproduce a UI bug, or whenever a task needs the live app, or on: verify, agent-view, check UI."
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
| `click` `fill` `drag`                | interaction by ref, text or coordinate; `click` `fill` also by test id or selector |
| `wait`                               | block until text, a test id or a selector appears; non-zero on timeout |
| `act`                                | step protocol for a cheap driver: numbered control table, done check, replay |
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
| Acting on an element `dom` shows with `[testid=…]`               | `click` / `fill` / `wait --testid <id>`                      | Survives HMR, navigation and copy changes; a ref and a text filter do not                   |
| An element that has not rendered yet                             | `wait --filter "<text>"`                                     | Exits on appearance and non-zero on timeout — a real gate, unlike a fixed pause             |
| Getting to a screen or through a flow with a known end state (login, a form) | `act list [section]` → `act replay <name>`; none fits → `act start --until-testid <id> --save <name> --in <section>`, or `--until-selector <css>` when the end state has no test id | Replay takes seconds and no model; a new path goes to the `act-decider` agent and is saved for the next run. The control table is read from the accessibility tree, so test ids are optional. See [Reaching the screen](#reaching-the-screen-under-test) |
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

## Execution discipline

A run produces one of four outcomes per step: **pass**, **fail**, **requires_visual_review**, **skipped** (the step
could not run; give the reason). There is no bucket called "actually fine, here's why".

**How to run the commands themselves:**

- **Never discard output.** No `>/dev/null`, no `2>&1` to nowhere, no `| head -1` on a command whose failure you have
  not yet read. Every agent-view command prints either the evidence or the reason it failed; a suppressed `click` that
  matched nothing looks exactly like a successful one.
- **Chain with `&&`, not newlines.** Newline-separated commands keep running after a failure, so a
  broken first step is followed by three steps acting on the wrong state. `&&` stops at the first
  non-zero exit (POSIX shells and PowerShell 7; Windows PowerShell 5.1 has no `&&`: use `; if ($?) { … }`).
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

**Reading the results:**

1. **A failed expectation is `fail`.** If output disagrees with what the step expected, mark `fail` and continue, with
   the expectation unchanged. Explanations belong in the bug report after the run, not in the per-step log.

2. **Never claim a `window.*` API is missing without `eval`.** Before reporting "API not exposed" /
   "global X doesn't exist" / "the host doesn't expose Y", run `agent-view eval "typeof window.X"`
   and report the literal result (`"undefined"` / `"object"` / `"function"`). DOM scraping cannot answer this — globals
   are not in the AX tree. If it returns `"undefined"` the API really is absent from the main world; anything else means
   the API is reachable and your earlier conclusion was wrong.

## Verification Workflow

Run the checks inline, with no subagent. The one exception is recording a new `act` path, which goes to
`act-decider` (see below). Resolve the window id once with `agent-view discover` if you need `--window`.
When a caller fans scenarios out to agents, give each agent one scenario: an agent carrying several runs
out of turns before it finishes any.

### Reaching the screen under test

Navigation is a recorded path, re-explored only when it broke:

1. `agent-view act list` prints the sections of the project's script store, one per product area (`auth`, `tree`,
   `editor/canvas`) plus `integration`; `act list <section>` prints its **steps** (one small action each) and
   **use cases** (a user goal built from steps, name ending in `-use-case`), one line each, linked to
   the script's JSON. Scripts live in the main checkout, so every worktree sees the same store.
2. A script lands where you need: `agent-view act replay <name>`. Its `after` prerequisite (a login), or a use case's
   steps, run first and are skipped when already met. DONE: go on. STALE: re-record under the same name.
3. No script fits: record the missing steps, one small action each, into the section of the area they drive. Hand
   the goal, a done condition, a name `<section>-<target>` (`settings-connections-open`) and the section to the
   `act-decider` agent, or drive `act start … --save <name> --in <section> --note "…"` yourself. Then, when the
   flow is worth repeating, chain the steps with `act save-use-case <name>-use-case --in <section> …` (`integration`
   when it crosses areas). A step that act cannot record is a missing act op or a missing test id in the app, never a
   shell script in the store; setup on disk is a fixture in `<section>/fixtures/`
   ([commands](references/commands.md#step-protocol-act)).

### Ad-hoc mode (standalone)

After code changes, every file in `git diff` that renders or drives UI gets at least one check, picked from the table
above (`agent-view launch` or `discover` first if the app is not up). After an interaction that could fail silently,
read `console --level error`. A screenshot comes last, as visual confirmation only. "Unreachable" is claimed only from
`coverage`, never from reading the diff; an empty result means "this action does not reach it".

### Scenario mode (from a plan)

When UI scenarios are pre-generated (e.g. a plan file with a `## UI Scenarios` section), follow
[`references/scenario-mode.md`](references/scenario-mode.md).

### Reporting

One line per step, so the report stays machine-readable:

```
<step label> | pass | fail | requires_visual_review | skipped — <evidence command and its result, or why it was skipped>
login form error | fail — dom --filter "Неверный пароль" --count → 0
```

Close with passed / failed / visual-review / skipped counts. Do not paste raw stdout unless asked.

**Design conformance** — when you are handed `(label, screenshot command, expected reference path)`
rows, follow [`references/design-conformance.md`](references/design-conformance.md).

## Resilience

- **Element not found:** `agent-view wait --filter "<text>" --timeout 5` covers the render delay after HMR. If it times
  out — report `fail`.
- **CDP disconnect:** `agent-view discover` to check. If no windows — `agent-view launch`. On
  `PORT_CONFLICT` the CLI reports the owning PID and process name; surface it and ask the user to free the port. Never
  kill a foreign process from this skill.
- **`CDP_TIMEOUT`:** the command hit the server-side deadline and cached sessions for that port were dropped, so retry
  once. Repeated timeouts mean the app's DevTools endpoint is wedged — restart it.
- **Retry budget: 2 per command**, then mark the step `skipped` with the reason. Two covers a transient CDP drop; a
  third repeat means the app or the plan is wrong, not the call.

## Token cost

Vision tokens dominate: a full-res screenshot is ≈19k tokens (1920×1080, 12 tiles), `--scale 0.5` ≈6k (4 tiles),
`--scale 0.25` and `--crop` ≈1.6k (1 tile); a text answer is ~50. So `--depth`, `--filter` and `--count` on `dom` cost
near nothing by comparison.
