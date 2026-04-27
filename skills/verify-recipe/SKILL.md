---
name: verify-recipe
description: "Generates a concrete, command-by-command agent-view recipe for verifying a feature or bugfix. Use when the developer wants to write a verify-recipe.md, create a verification plan, build an agent-view recipe, or produce a verify checklist for a change they shipped. Triggers on: write a verify-recipe, write verification steps, generate verify steps for the feature/bug I just shipped/fixed, make a verify-recipe.md, what should I run to verify X, create a verification plan, agent-view recipe for this fix, verify checklist for this feature. Does NOT execute the checks — it authors the plan. For running checks against a live app, use the verify skill instead."
allowed-tools: Read, Write, Bash(agent-view *)
---

# Verification Recipe Generator

You help the developer author a disciplined, cheapest-first verification recipe for a feature they shipped or a bug they fixed. You do not run the checks — you produce a `.claude/verify-recipes/<slug>.md` file that any AI coding agent can execute later.

## What this produces

A file at `.claude/verify-recipes/<kebab-slug>.md` with three precondition phases plus the verification body:

- **MANUAL PRECONDITIONS** — only what `agent-view` physically cannot do (rare; usually empty)
- **BRINGUP** — idempotent setup steps the verify-runner executes itself: `if <state-check> is falsy → run actions → wait for state to settle`. Drives the app from auth screen / fresh shell / mid-state into the exact state the recipe needs. Re-runs cost almost nothing because each step skips when its condition is already met.
- **MACHINE PRECONDITIONS** — pure state queries that confirm Bringup actually settled. No actions here. Any false → runner aborts.
- **EVIDENCE COMMANDS** — ordered `agent-view` calls, cheapest first, each annotated with what it proves.
- **POSITIVE-CASE ASSERTIONS** + **REGRESSION CHECKS** + optional **DESIGN CONFORMANCE**.

Create the directory if missing: `mkdir -p .claude/verify-recipes`

## Why three precondition phases

| Phase | Who runs it | What it does | Idempotent? |
|---|---|---|---|
| `## Manual Preconditions` | Human (or main agent) | Only what `agent-view` physically can't (USB token, hardware setup, multi-machine state) | n/a |
| `## Bringup` | verify-runner | `if state-check is falsy → action → wait`. Logins, mounting widgets, navigation — anything `agent-view` can do deterministically | YES (per step) |
| `## Machine Preconditions` | verify-runner | Pure `eval` / `dom --filter` state queries. NO actions. | trivially |

**Why split Bringup from Machine Preconditions?** A failure tells you a different thing in each:
- A failed Bringup post-condition → bringup spec is wrong (e.g., `selectLocationAndFly` doesn't exist; "Войти" button text changed). Author error.
- A failed Machine Precondition after Bringup succeeded → bringup THINKS it set up the state but the state isn't there (e.g., login appeared to succeed but the user role is wrong, the app is in a degraded mode). Real environment issue.
- A failed Evidence Command after both passed → real bug in the verified feature.

Without the split, all three look like "step N failed" and the developer can't tell which.

**Why keep Manual at all?** Some things really can't be automated cheaply: physical USB-key auth, multi-machine setups, long-running data migrations. List them — but be honest, this section should usually be empty.

## Methodology

Frame the recipe with **hard-debug** discipline. Apply this chain in authoring mode:

1. Start from the broadest possible starting state — recipe should run from auth screen, from logged-in shell, or from "already in the feature" without modification.
2. Convert vague expectations ("looks right") into measurable signals ("`store.user.role === 'admin'`").
3. Prefer the cheapest tool that can answer the question — a value check costs ~50 tokens, a screenshot costs ~6 000.
4. Include at least one negative-case check (the old symptom must no longer appear).
5. Include at least one regression check (an adjacent flow must still work).
6. **Bringup steps must be conditional + idempotent.** Every action wrapped in `if <state-check> is falsy`. Every action followed by `wait for <post-condition> to be truthy`. Re-running the recipe must be a no-op when the app is already ready.

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
- Putting UI clicks (`click`, `fill`) in `## Machine Preconditions`. Actions go in `## Bringup`. Machine Preconditions are state queries only.
- Bringup steps without an IF condition (unconditional actions). They break idempotency — re-running a "click Login" step when already logged in fails. Always wrap.
- Bringup steps without a post-condition wait. Without it, the runner advances before the action settled, and the next step's IF check sees stale state.
- Manual Preconditions for anything `agent-view` can do. Drag widget into cell? Often there's a programmatic API — interview the developer for it before defaulting to Manual.
- Hardcoded credentials in Bringup commands. Use env-var references (`"$AGENTVIEW_PASSWORD"`) — never inline a password, even for dev/masterkey accounts. Recipes get committed to git.
- Opening Evidence Commands with a screenshot to "see the state" — use `dom --filter` or `eval` first.
- "Check that it looks right" — every Evidence assertion must be a concrete pass/fail criterion. The single legitimate exception is the `## Design Conformance` section.
- Inventing design reference paths (`.figma-refs/...`) when the developer did not provide them. No refs → no Design Conformance section.

## Workflow

### Step 1 — gather context (interview the developer)

When invoked, ask in plain text. Wait for response before continuing.

**Block A — what's being verified:**

1. What was shipped or fixed? (feature name or bug description)
2. What was the original symptom or expected behavior?
3. Any known failure mode or edge case to cover?

**Block B — bringup: how the runner gets the app into a state where verification makes sense:**

4. **Authentication** — does the app require login before the feature is reachable? If yes:
   - What identifies "logged out" vs "logged in" in JS state? (e.g., `typeof window.__dev`, `!!store.user`)
   - Login flow: which fields/buttons (`fill --filter "..."`, `click --filter "..."`) and what credentials? **Use an env-var, never inline.** Suggest a name like `AGENTVIEW_PASSWORD` and tell the user to `export` it in their shell or `.env.local`.
5. **UI mode / view requirements** — does the feature live behind a specific app mode/view that must be active before it appears (e.g., "map view, not settings panel"; "edit mode, not view mode"; "modal X must be open")? For each:
   - State check that proves this mode is active (e.g., `document.querySelector('.cesium-widget') !== null` for map mode).
   - Action(s) to enter this mode if not active. Prefer programmatic API (e.g., `eval "store.setMode('map')"`) over UI clicks. If only UI works, list the click sequence.
6. **Setup actions** — beyond modes, what other setup must happen (drag widget into cell, navigate camera to a location, open a dialog)? For each:
   - Programmatic API if it exists (e.g., `gis-widget-root.selectLocationAndFly(uuid)`, `workspace.addWidget(...)`). Prefer this — much more reliable than UI automation.
   - State check that proves the setup happened.
   - Wait timing: how long does this take to settle? (camera animation, async data load).

If the developer doesn't know whether a programmatic API exists, ask them to point you at the relevant store/composable/component file — you can read it and find one (or confirm none).

**Block C — verification body and visual:**

7. State assertions for the verified feature itself — JS expressions that prove it works (separate from bringup setup checks).
8. **(Optional) Design references** — local image paths to compare screenshots against (Figma exports, hand-off PNGs). **Only local files are supported.** If none — skip the Design Conformance section.

### Step 2 — draft the recipe

Use the answers to produce a recipe in this format:

````markdown
# Verify: <feature or fix name>

Generated: <date>
Scope: <one sentence describing what this covers>

## Manual Preconditions
<!-- ONLY for things agent-view physically cannot do. Usually empty. -->
<!-- The verify-runner does NOT execute these. -->
(none — bringup handles everything)

## Bringup
<!-- The verify-runner executes these. Each step is conditional + idempotent: skipped if already in target state. -->
<!-- Format per step: -->
<!--   ### B<N>. <one-line title> -->
<!--   - if `<eval>` is `<falsy criterion>`: -->
<!--       <action command 1> -->
<!--       <action command 2> -->
<!--     wait for `<post-condition eval>` to be `<truthy criterion>`, timeout <Ns> -->

### B1. Login if on auth screen
- if `agent-view eval "typeof window.__dev"` is not `"object"`:
    agent-view fill --window $W --filter "Логин" "root"
    agent-view fill --window $W --filter "Пароль" "$AGENTVIEW_PASSWORD"
    agent-view click --window $W --filter "Войти"
  wait for `agent-view eval "typeof window.__dev"` to be `"object"`, timeout 15s

### B2. Mount the GIS widget if not mounted
- if `agent-view eval "!!window.__dev.pinia._s.get('gis-widget-root')?.cesiumReadyFlag"` is `false`:
    agent-view eval "window.__dev.pinia._s.get('workspace').addWidget({type:'gis', cell:0})"
  wait for `agent-view eval "!!window.__dev.pinia._s.get('gis-widget-root')?.cesiumReadyFlag"` to be `true`, timeout 10s

### B3. Exit settings mode if active
- if `agent-view eval "document.querySelector('.cesium-widget') !== null"` is `false`:
    agent-view click --window $W --filter "Готово"
  wait for `agent-view eval "document.querySelector('.cesium-widget') !== null"` to be `true`, timeout 5s

### B4. Fly to first sublocation
- if `agent-view eval "!!window.__dev.pinia._s.get('gis-widget-root')?.selectedLocation"` is `false`:
    agent-view eval --await "window.__dev.pinia._s.get('gis-widget-root').selectLocationAndFly(window.__dev.mwStore.nvgn.sublocations.value[0].id)"
  wait for `agent-view eval "(()=>{const w=document.querySelector('.cesium-widget'); const cw=Object.values(w).find(v=>v?.scene); return Math.round(window.Cesium.Cartographic.fromCartesian(cw.scene.camera.position).height);})()"` to be `< 5000`, timeout 30s

### B5. Snapshot for the report (always runs)
agent-view screenshot --window $W --scale 0.25

## Machine Preconditions
<!-- Pure state checks. NO actions. The verify-runner aborts with `precondition_failed` if any return false. -->
- `agent-view eval "typeof window.__dev"` → must be `"object"`
- `agent-view eval "!!window.__dev.pinia._s.get('gis-widget-root')?.cesiumReadyFlag"` → must be `true`
- `agent-view eval "document.querySelector('.cesium-widget') !== null"` → must be `true`
- `agent-view eval "!!window.__dev.pinia._s.get('gis-widget-root')?.selectedLocation"` → must be `true`
- `agent-view eval "({locations:window.__dev.mwStore.nvgn.locations.value.length, sublocations:window.__dev.mwStore.nvgn.sublocations.value.length, zones:window.__dev.mwStore.nvgn.zones.value.length, objects:window.__dev.mwStore.nvgn.objects.value.length})"` → all four counts must be `> 0`

## Narrowed Signal
<!-- The one measurable thing that proves the verified feature works -->
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
<!-- Include ONLY if the developer provided design refs in question 8. -->

| Step Label | Screenshot Command | Expected Reference |
|---|---|---|
| <area name e.g. "filter panel collapsed"> | `agent-view screenshot --crop "<area>" --scale 0.5` | `<absolute path to expected PNG/JPEG>` |

Tolerance: `normal` (default).

## Anti-patterns avoided
- <note any recipe-specific traps, e.g. "B4 relies on `selectLocationAndFly` from gis-widget-root — verified to exist as of <date>; if it's removed, B4 falls back to Manual Precondition">
````

### Step 3 — save the file

Determine a kebab-slug from the feature/fix name. Save to `.claude/verify-recipes/<slug>.md`. Create the directory first if it doesn't exist. Confirm the path to the developer.

### Step 4 — credentials warning (if Bringup contains login)

If Bringup includes a login step:

> Recipe uses `$AGENTVIEW_PASSWORD` for login. Make sure that env var is set in your shell or `.env.local` before running verify (`export AGENTVIEW_PASSWORD=<value>`). The recipe never contains the literal password.

If the developer insisted on inlining a literal password earlier, warn:

> ⚠️ Recipe contains a literal password on line N. This will be committed to git. Consider replacing with `$AGENTVIEW_PASSWORD` (env-var). Want me to convert it now? (yes/no)

### Step 5 — offer dry-run validation

After saving, ask:

> The recipe is saved at `<path>`. Is the app running? If yes, I can spawn `verify-runner` in `dry_run` mode — it'll execute Bringup + Machine Preconditions + the first Evidence Command (~10-20 commands total). That validates the recipe isn't broken before you commit a full run. Want me to run the dry-run? (yes/no)

If yes:
1. Get the window id with `agent-view discover`.
2. Spawn `verify-runner` via the Agent tool with `mode: dry_run`, the recipe path, and the window id.
3. Read the JSON report.
4. **`status: bringup_failed`** → relay `failed_bringup_step` and the post-condition's actual value. Suggest revising the bringup step (most often: action commands wrong, programmatic API doesn't exist, or post-condition criterion mistuned).
5. **`status: precondition_failed`** → bringup ran but state isn't there. Either bringup is incomplete, or a state check is overly strict. Show both bringup outcome and the failing precondition.
6. **`status: completed` and dry-run passed** → recipe is healthy. Confirm and stop.

If no — confirm path and stop.

## Worked example: GIS feature with full bringup automation

**Developer input:**
> Verifying selective filter changes (commits 0c5f1b1ee, 4d0c89467, 4c99c1591) in the GIS widget. App requires login (root/masterkey via middleware). GIS widget mounts via `workspace.addWidget({type:'gis', cell:0})`. Camera flies via `gis-widget-root.selectLocationAndFly(id)`. Map view is the default after widget mount.

**Recipe produced:**

(see the template above — it's already the worked example for this scenario)

**Saved to:** `.claude/verify-recipes/nvgn-gis-improvements.md`

**Dry-run output (first run after auth screen):**
```
status: completed
mode: dry_run
bringup: 5 steps, 12 commands, 18s — B1 (login) + B2 (mount) + B4 (fly) all triggered; B3 skipped (already map mode); B5 screenshot saved
machine_preconditions: 5/5 passed
steps: 1/1 passed
```

**Dry-run output (second run, app already in target state):**
```
status: completed
mode: dry_run
bringup: 5 steps, 5 commands (4 IF-checks + 1 screenshot), 3s — all 4 conditional steps skipped_already_ready
machine_preconditions: 5/5 passed
steps: 1/1 passed
```

This is what idempotent bringup buys you: 5x speedup on re-runs, zero manual intervention either way.
