---
name: verify-recipe
description: "Generates a concrete, command-by-command agent-view recipe for verifying a feature or bugfix. Use when the developer wants to write a verify-recipe.md, create a verification plan, build an agent-view recipe, or produce a verify checklist for a change they shipped. Triggers on: write a verify-recipe, write verification steps, generate verify steps for the feature/bug I just shipped/fixed, make a verify-recipe.md, what should I run to verify X, create a verification plan, agent-view recipe for this fix, verify checklist for this feature. Does NOT execute the checks — it authors the plan. For running checks against a live app, use the verify skill instead."
allowed-tools: Read, Write, Bash(agent-view *)
---

# Verification Recipe Generator

You help the developer author a disciplined, cheapest-first verification recipe for a feature they shipped or a bug they fixed. You do not run the checks — you produce a `.claude/verify-recipes/<slug>.md` file that any AI coding agent can execute later.

## What this produces

A file at `.claude/verify-recipes/<kebab-slug>.md` containing:

- **MANUAL PRECONDITIONS** — human-readable setup steps (drag widget here, navigate to view X) that a person or the parent agent must do before any automated check
- **MACHINE PRECONDITIONS** — runnable `agent-view` checks that prove the manual setup actually took effect; the verify-runner subagent runs these FIRST and aborts cleanly if any fail
- **NARROWED SIGNAL** — the measurable indicator that proves success or failure
- **EVIDENCE COMMANDS** — ordered `agent-view` calls, cheapest first, each annotated with what it proves
- **POSITIVE-CASE ASSERTIONS** — what "pass" looks like for each command
- **REGRESSION CHECKS** — adjacent paths that must not have broken
- **DESIGN CONFORMANCE** (optional) — screenshot ↔ design reference pairs for the design-conformance-runner

Create the directory if missing: `mkdir -p .claude/verify-recipes`

## Why two kinds of preconditions

The verify-runner subagent is intentionally tightly scoped — it executes commands and reports results, with hard budgets that prevent it from "looking around" when things don't match. That means **the recipe must clearly separate what a human does from what a machine verifies**.

If you write a precondition as prose ("the GIS widget is dragged into a workspace cell"), the runner can't check it. If the user forgot to do it, the runner blunders into Evidence Commands that depend on missing UI, and either burns its budget on a recipe-stale abort or — worse, in older formats — flails trying to find the missing element.

The fix: every Manual Precondition gets a paired Machine Precondition that proves it took effect. Drag widget into cell → check `cesiumReadyFlag === true`. Navigate to map mode → check `document.querySelector('.cesium-widget')` exists. Now if the user skips a step, the runner aborts cleanly on Phase 1 with a clear "do this first" message instead of diagnosing phantom bugs.

## Methodology

Frame the recipe with **hard-debug** discipline. Apply this chain in authoring mode:

1. Start from a **reproducible, machine-checkable** starting state — not "open the app and poke around"
2. Convert vague expectations ("looks right") into measurable signals ("store.user.role === 'admin'")
3. Prefer the cheapest tool that can answer the question — a value check costs ~50 tokens, a screenshot costs ~6 000
4. Include at least one negative-case check (the old symptom must no longer appear)
5. Include at least one regression check (an adjacent flow must still work)
6. **Every Manual Precondition needs a Machine Precondition counterpart.** If you can't think of one — interview the developer further before writing the recipe (see Step 1 below).

## Tool-cost decision tree

Pick the first row that can answer the question. Only go lower when the row above can't:

| Question | Command | Why it's cheapest |
|---|---|---|
| Element exists / has specific text / role | `agent-view dom --filter "<text>" --depth 2` | Structured text, zero vision tokens |
| App state, store value, computed flag | `agent-view eval "<expr>"` | Returns the value directly; DOM inference is wasteful and fragile |
| What changed between action and final state | `agent-view watch "<expr>" --until "<condition>"` or `--max-changes 1` | `eval` shows the snapshot; `watch` shows the trajectory |
| SharedWorker / ServiceWorker internal state | `agent-view eval --target <name> "<expr>"` | Workers have no DOM; this is the only path |
| Did this action throw or warn silently? | `agent-view console --clear` before, `agent-view console --level error,warn` after | Catches uncaught exceptions and network failures invisible to DOM |
| Layout, spacing, visual regression | `agent-view screenshot --scale 0.5` | Last resort — the only tool that sees pixels, but costs ~6 000 tokens |
| Canvas / WebGL scene state | `agent-view scene --diff` | DOM is empty for canvas apps |

**Anti-patterns to reject:**
- Mixing manual setup and machine checks under a single "Repro Steps" heading. Always split into Manual Preconditions + Machine Preconditions.
- Manual Precondition without a Machine counterpart — the runner can't verify it, so the user can silently violate it.
- Opening Evidence Commands with a screenshot to "see the state" — use `dom --filter` or `eval` first
- Using `eval` when `dom --filter` answers the question
- Assertions that depend on transient state without `watch --until` to stabilize first
- "Check that it looks right" — every Evidence assertion must be a concrete pass/fail criterion. The single legitimate exception is the `## Design Conformance` section, which delegates visual judgment to the design-conformance-runner subagent against an explicit reference image.
- Inventing design reference paths (`.figma-refs/...`, `assets/mockups/...`) when the developer did not provide them. No refs → no Design Conformance section.

## Workflow

### Step 1 — gather context (interview the developer)

When invoked, ask the developer in plain text (no tool calls yet). Wait for the response before continuing.

1. **What was shipped or fixed?** (feature name or bug description)
2. **What was the original symptom or expected behavior?**
3. **Any known failure mode or edge case to cover?**
4. **UI mode requirements**: Does this feature live behind a specific app mode/view that must be active before it appears (e.g., "map view, not settings panel"; "edit mode, not view mode"; "modal X must be open")? List every mode-toggle the user must have done.
5. **Manual setup steps**: Beyond modes, what physical actions must the user do before checks can run (drag a widget into a cell, search for and select a map location, open a specific dialog, log in as a particular role)? Be precise — these become Manual Preconditions verbatim.
6. **State assertions for each manual step**: For each item in (4) and (5), is there a JS expression or DOM selector that proves it happened? Examples: "after dragging the GIS widget — `pinia._s.get('gis-widget-root')?.cesiumReadyFlag` becomes true"; "after entering map mode — `document.querySelector('.cesium-widget')` exists; "after selecting a location — `selectedLocation` is truthy". If the developer doesn't know offhand, that's fine — ask them to point you at the store/composable/component where state lives and you can suggest expressions.
7. **(Optional) Design references**: Local image paths to compare screenshots against (Figma exports, hand-off PNGs). **Only local files are supported.** If none — skip the Design Conformance section entirely.

If the answers to (4)/(5) reveal something the developer can't pair with a machine check (6), say so explicitly: "I'll write `<step>` as a Manual Precondition with no Machine counterpart — that means if a user skips it, the runner won't catch it and may report misleading failures. Want to add a custom check?" Then either (a) get an expression from them, or (b) accept the gap and note it in the recipe's Anti-patterns section.

### Step 2 — draft the recipe

Use the answers to produce a recipe in this format:

````markdown
# Verify: <feature or fix name>

Generated: <date>
Scope: <one sentence describing what this covers>

## Manual Preconditions
<!-- Done by a human or the parent agent BEFORE invoking verify-runner. The runner does NOT execute these. -->
1. <Action 1 — exact, no ambiguity. e.g. "Open the GIS widget by dragging it from the 'Edit workspace' panel into the upper-left cell.">
2. <Action 2 — e.g. "In the map header search box, type 'Склад_1' and click the matching dropdown entry to fly the camera to that sublocation.">
3. <Action 3 — e.g. "Zoom in until building details are visible (camera height < 1000 m).">

## Machine Preconditions
<!-- The verify-runner runs these FIRST. If ANY fail, it aborts with `precondition_failed` and shows the Manual Preconditions block to the user. -->
- `agent-view eval "window.__dev !== undefined"` → must be `true`
- `agent-view eval "!!window.__dev.pinia._s.get('gis-widget-root')?.cesiumReadyFlag"` → must be `true`
- `agent-view eval "!!window.__dev.pinia._s.get('gis-widget-root')?.selectedLocation"` → must be `true`
- `agent-view eval "document.querySelector('.cesium-widget') !== null"` → must be `true`

## Narrowed Signal
<!-- The one measurable thing that proves it works -->
`<agent-view command>` must return `<expected value>`.

## Evidence Commands

### 1. <What this proves>
```bash
agent-view <command>
```
Expected: <concrete criterion — value, text, absence of error>
Cost: ~<N> tokens

### 2. ...

## Positive-Case Assertions
- [ ] <criterion>
- [ ] <criterion>

## Regression Checks
- [ ] <adjacent flow> — `agent-view <command>` → `<expected>`

## Design Conformance
<!-- INCLUDE THIS SECTION ONLY IF the developer provided design refs in question 7. -->
<!-- Each row pairs a screenshot command with the expected reference image path. -->
<!-- The design-conformance-runner subagent reads this section, runs the screenshot commands, and visually compares against the expected refs. -->
<!-- Do NOT invent design ref paths. Use exactly what the developer provided. -->

| Step Label | Screenshot Command | Expected Reference |
|---|---|---|
| <area name e.g. "filter panel collapsed"> | `agent-view screenshot --crop "<area>" --scale 0.5` | `<absolute path to expected PNG/JPEG>` |
| <area name> | `agent-view screenshot --window $W --scale 0.5` | `<absolute path>` |

Tolerance: `normal` (default — flag deviations a designer would notice in code review). Use `loose` only if the developer says exact pixel parity is not required.

## Anti-patterns avoided
- <note any recipe-specific traps, e.g. "manual step 3 (zoom) has no machine counterpart — runner cannot detect insufficient zoom; mitigated by Evidence Step N which checks camera height">
````

### Step 3 — save the file

Determine a kebab-slug from the feature/fix name (e.g. `login-redirect-fix`, `cart-total-display`).

Save to `.claude/verify-recipes/<slug>.md`. Create the directory first if it doesn't exist.

Confirm the path to the developer.

### Step 4 — offer dry-run validation

After saving, ask the developer:

> The recipe is saved at `<path>`. Is the app running? If yes, I can spawn `verify-runner` in `dry_run` mode — it'll execute only the Machine Preconditions and the first Evidence Command (~5 commands total). That validates the recipe isn't broken before you commit a full run. Want me to run the dry-run? (yes/no)

If yes:
1. Get the window id with `agent-view discover`.
2. Spawn `verify-runner` via the Agent tool with `mode: dry_run`, the recipe path, and the window id.
3. Read the JSON report.
4. If `status: completed` and dry-run preconditions+step 1 passed → tell the developer the recipe is healthy and ready for a full run.
5. If `precondition_failed` → relay the `failed_precondition` and `manual_preconditions_to_check` so the developer knows what setup step to do (or what Machine Precondition to fix).
6. If the first Evidence Command failed → flag it: the recipe likely has a stale ref/selector or assumes UI state that doesn't exist; offer to revise.

If no — confirm the path and stop.

## Worked example: "fixed login redirect bug"

**Developer input:**
> Fixed a bug where after login, the redirect went to `/home` instead of `/dashboard`. Store mutation `SET_REDIRECT_PATH` was missing. No visual change — purely a routing issue. No special UI mode — just the login page. Manual setup is "be on the /login route".

**Recipe produced:**

````markdown
# Verify: Login Redirect Fix

Generated: 2026-04-27
Scope: Confirms that a successful login routes to /dashboard, not /home, and that the store mutation fires correctly.

## Manual Preconditions
1. App running, user logged out, browser at the `/login` route.

## Machine Preconditions
- `agent-view eval "router.currentRoute.path"` → must be `"/login"`
- `agent-view eval "!!store.state.auth.user"` → must be `false` (logged out)

## Narrowed Signal
`agent-view eval "router.currentRoute.path"` must return `"/dashboard"` after sign-in.

## Evidence Commands

### 0. Setup — baseline console
```bash
agent-view console --clear
```
Expected: `Console buffer cleared`
Cost: ~10 tokens

### 1. Confirm redirect target
```bash
agent-view dom --filter "Email" --depth 2
agent-view fill <email-ref> "admin@example.com"
agent-view fill <password-ref> "password"
agent-view click <signin-ref>
agent-view watch "router.currentRoute.path" --until "router.currentRoute.path === '/dashboard'"
```
Expected: `replace /  "/login" → "/dashboard"` in watch output
Cost: ~150 tokens

### 2. Confirm mutation fired
```bash
agent-view eval "store.state.auth.redirectPath"
```
Expected: `"/dashboard"` (not `"/home"`, not `null`)
Cost: ~50 tokens

### 3. No errors during login flow
```bash
agent-view console --level error,warn
```
Expected: `(no console messages)`
Cost: ~30 tokens

## Positive-Case Assertions
- [ ] `router.currentRoute.path` === `/dashboard` after login
- [ ] `store.state.auth.redirectPath` === `/dashboard`
- [ ] No console errors during the flow

## Regression Checks
- [ ] Logout → `/login` still works (`agent-view click <logout-ref>` then `agent-view eval "router.currentRoute.path"` → `"/login"`)

## Anti-patterns avoided
- Not using screenshot to confirm route (route is a string — eval is 120× cheaper)
- watch used before eval so the route change is confirmed to have settled, not just sampled mid-transition
````

**Saved to:** `.claude/verify-recipes/login-redirect-fix.md`
