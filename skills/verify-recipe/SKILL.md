---
name: verify-recipe
description: "Generates a concrete, command-by-command agent-view recipe for verifying a feature or bugfix. Use when the developer wants to write a verify-recipe.md, create a verification plan, build an agent-view recipe, or produce a verify checklist for a change they shipped. Triggers on: write a verify-recipe, write verification steps, generate verify steps for the feature/bug I just shipped/fixed, make a verify-recipe.md, what should I run to verify X, create a verification plan, agent-view recipe for this fix, verify checklist for this feature. Does NOT execute the checks — it authors the plan. For running checks against a live app, use the verify skill instead."
allowed-tools: Read, Write, Bash(agent-view *)
---

# Verification Recipe Generator (rigor edition)

You help the developer author a disciplined, cheapest-first verification recipe for a feature they shipped or a bug they fixed. You do not run the checks — you produce a `.claude/verify-recipes/<slug>.md` file that any AI coding agent can execute later.

This edition is hardened against the failure mode of "construction-validated only" recipes that pass while real bugs sit in plain sight in the same data. See `## Bug-class invariants` and `## Discipline rules`.

## What this produces

A file at `.claude/verify-recipes/<kebab-slug>.md` containing:

- **REPRO STEPS** — exact state the app must be in before checks run.
- **NARROWED SIGNAL** — the measurable indicator that proves success or failure.
- **EVIDENCE COMMANDS** — ordered `agent-view` calls, cheapest first.
- **POSITIVE-CASE ASSERTIONS** — what "pass" looks like for each command.
- **BUG-CLASS INVARIANTS** *(required)* — properties that must hold across all states the recipe touches, not just the action-result state.
- **ROUND-TRIP CHECKPOINT** *(required when the feature touches persistence or mutable structure)* — a save-and-reload (or equivalent) comparison.
- **REGRESSION CHECKS** — adjacent paths that must not have broken.
- **DESIGN CONFORMANCE** *(optional)* — reference image comparisons.

Create the directory if missing: `mkdir -p .claude/verify-recipes`

## Methodology

Frame the recipe with **hard-debug** discipline: REPRO → narrowed signal → minimize scope → root-cause check → fix verification.

1. Start from a reproducible starting state, not "open the app and poke around".
2. Convert vague expectations ("looks right") into measurable signals (`store.user.role === 'admin'`).
3. Prefer the cheapest tool that can answer the question — a value check costs ~50 tokens, a screenshot costs ~6 000.
4. Include at least one negative-case check (the old symptom must no longer appear).
5. Include at least one regression check (an adjacent flow must still work).
6. **Construction-only verification is not enough.** For any non-trivial feature, add invariant checks (see next section) and a round-trip checkpoint.

## Bug-class invariants (required section in every recipe)

The recipe must include an `## Invariants` section listing properties that hold *regardless of how state was reached*. These catch bugs that construction-only tests cannot see, because the bug lives in the gap between what the model says and what the user sees / what persistence preserves.

Pick at least one invariant from each applicable class. Skip a class only if it provably cannot apply to the feature.

### Class A — UI ≡ Model
For every visible representation of state (tree, list, panel, breadcrumb, overlay, badge, count):
- **Count parity:** `count(DOM rows of kind X) === count(model nodes of kind X)`.
- **Hierarchy parity:** for any parent/child relationship the model expresses, the DOM must mirror it. A flat-rendered DOM of a nested model is a UI bug, not a model bug.
- **Text parity:** the label shown in the UI for a node must equal `model.get(nodeId).name` (or whichever field the UI claims to display).

Encode this as a single `eval` that returns a JSON struct so a single failed comparison is unambiguous:

```bash
agent-view eval "var model=<source-of-truth>;var dom=<measurement>;JSON.stringify({modelCount:model.size, domCount:dom.length, match:model.size===dom.length})"
```

If `match: false` — that is a FAIL. Do not rationalize a DOM/model count mismatch as "label reuse" or "the breadcrumb counts too" without confirming the matched elements' bounding boxes and DOM ancestry first.

### Class B — Round-trip
For any feature that creates / mutates persisted structure:
- `state ≡ deserialize(serialize(state))` (model survives save→load with bit-identical structure for the projected fields).
- `world(child) === origWorld(child)` immediately after a wrap/unwrap action (the wrapping must not silently shift the wrapped element).
- Reloading the page (`agent-view eval "location.reload()"`) and re-reading the same state must produce an identical signature.

A round-trip discrepancy that the save serializer silently "fixes" is a model bug, not a save-format bug. Live-vs-persisted divergence between actions and reloads is a class-B failure even if save/load round-trips cleanly with itself.

### Class C — Reversibility & identity
- Every user-facing command produces exactly one `commandHistory` entry (`canUndo→true`; one `undo()` fully reverses).
- `undo` then `redo` produces an identical state to "do once".
- The set of nodes after `do → undo → redo` equals the set after one `do`. Compare full IDs, not counts — a swap of one node for another with the same name is a real bug.

### Class D — No phantom state
- For each visible entity the user can interact with, there exists exactly one corresponding model node.
- For each model node, there exists at most one corresponding UI entity in each view.
- An entity that appears in two views (e.g. tree and canvas) must have the same identity in both (the same `nodeId` resolves both).

This class is the one most often missed. Verify it explicitly when the feature changes structure.

### Class E — Config conformance (rendering vs. configured constraint)

Class A compares model to DOM. Class E compares the **rendered output** (DOM bounds, canvas geometry, computed styles, layout sizes) to an **explicit configuration value** the system declares it must respect. This is the home for invariants that have no DOM counterpart to diff against — they assert against a config the user (or product) chose.

Typical examples — adapt names to the project:

- **Snap/grid:** every shape's bounding box must satisfy `x % gridSize === 0` (and same for `y / width / height`). Read `gridSize` from the live config (`store.gridSettings.gridSize`, `theme.grid.size`, `viewport.snap`, …); do not hardcode.
- **Viewport bounds:** elements declared "viewport-contained" must have `getBoundingClientRect()` within the viewport rect.
- **Z-order / layering:** elements declared "above modals" must have computed `z-index` above the modal's. Compare against the configured layer table, not a literal number.
- **Spacing / density tokens:** if the design system declares a spacing scale, computed `margin` / `padding` must be a multiple of the base token.
- **Theme tokens:** computed colors / fonts must match the active theme's declared values, not literal hex codes.

Generic helper shape:

```bash
agent-view eval "var cfg=<read live config value>; var items=<measure rendered items>; var off=items.filter(function(it){return !<conforms(it, cfg)>}); JSON.stringify({cfg:cfg, total:items.length, offCount:off.length, sample:off.slice(0,3)})"
```

Expected: `offCount: 0`. A non-zero count means the renderer ignored a config the system promised to honor — that is a real bug class, even if the model is internally consistent and round-trips cleanly. Bugs of the form "element is half a pixel off the grid", "modal renders behind the toast", "freshly-created group is not snapped" all live here and fall between the other classes.

When generating recipes, ask: *what config values does this feature claim to respect?* Each one is one Class-E invariant. If the answer is "none" — say so explicitly in the recipe, so a future reader doesn't wonder why the class is absent.

## Discipline rules

These rules govern how the recipe is *executed* — they must appear verbatim in the recipe's `## Discipline` section so the executor cannot forget them.

1. **A failed `Expected:` line is FAIL, not "actually fine".** Rationalizations belong in the bug report after the run, not inline in the run log. If the actual output disagrees with the expected line, mark `FAIL` and continue to the next step; do not edit the expected line, do not invent a "label reuse" or "convention" explanation that makes the discrepancy disappear from the count.

2. **Prefer model-vs-DOM mismatches as the bug, not as noise.** When a Class-A invariant fails, the default hypothesis is "the UI renderer is wrong", not "the DOM filter matched something extra". To rule out the latter, query bounding boxes and ancestor chains for every match; if the matches turn out to be sibling rows in the same list, the renderer is the bug.

3. **Defensive eval reads.** Every read of `node.transform.x` (or any model field) must include a sentinel: `isFinite(value)` or `value !== undefined`. A silent `NaN`/`null` from a renamed field looks like a real `0` in arithmetic and will fail-pass the assertion.

4. **No hardcoded literal IDs.** All node IDs in evals must be resolved by role at runtime (e.g. "the first group at root", "the line at root not inside any group"). Hardcoded prefixes silently degrade the recipe to no-op when the scene differs.

5. **The reload checkpoint is not optional.** For any recipe that touches mutable structure, include at least one `location.reload()` between an action and a re-measurement. Compare the projected signature before and after; differences are real bugs, not "fixed-up on save".

6. **Compose, do not narrate.** Final report is `pass / fail / requires_visual_review` counts plus one-line failure reasons. Do not paste raw stdout. Do not include prose justifications in the per-step output.

7. **`requires_visual_review` is an executor verdict, not an authoring shortcut.** When generating the recipe, draft every step so it executes through `agent-view`. Do not write `requires_visual_review` as the planned status of a step just because the path looks tricky (event delegation, canvas hit-test, file dialog, etc.) — first encode the cheapest sub-check that *can* run programmatically (e.g. "no console error during the action", "model state changed", "command history advanced by one"). The `requires_visual_review` label is set by the *executor* at run time, only after at least one genuine attempt to drive the action via agent-view failed for a reason they record. Authoring the recipe with `requires_visual_review` prebaked is what lets real regressions sit unobserved.

## Tool-cost decision tree

Pick the first row that can answer the question. Only go lower when the row above can't:

| Question | Command | Why it's cheapest |
|---|---|---|
| Element exists / has specific text / role | `agent-view dom --filter "<text>" --depth 2` | Structured text, zero vision tokens |
| Count of matching elements | `agent-view dom --filter X --count` | Single integer, zero tree tokens |
| App state, store value, computed flag | `agent-view eval "<expr>"` | Returns the value directly; DOM inference is wasteful and fragile |
| What changed between action and final state | `agent-view watch "<expr>" --until "<condition>"` or `--max-changes 1` | `eval` shows the snapshot; `watch` shows the trajectory |
| SharedWorker / ServiceWorker internal state | `agent-view eval --target <name> "<expr>"` | Workers have no DOM |
| Did this action throw or warn silently? | `agent-view console --clear` before, `agent-view console --level error,warn` after | Catches uncaught exceptions invisible to DOM |
| Layout, spacing, visual regression | `agent-view screenshot --scale 0.5` | Last resort — only tool that sees pixels (~6 000 tokens) |
| Canvas / WebGL scene state | `agent-view scene --diff` | DOM is empty for canvas apps |

**Anti-patterns to reject:**
- Opening with a screenshot to "see the state" — use `dom --filter` or `eval` first.
- Using `eval` when `dom --filter` answers the question.
- Assertions that depend on transient state without `watch --until` to stabilize first.
- "Check that it looks right" — every assertion must be a concrete pass/fail criterion. Single legitimate exception: `## Design Conformance`.
- Inventing design reference paths (`.figma-refs/...`) when the developer did not provide them.
- **Treating SG (or any model layer) as the sole source of truth.** Model is one of several representations; the bug may live in the gap between model and UI. The recipe must check the gap explicitly.

## Workflow

### Step 1 — gather context

Ask in plain text (no tool calls yet):

1. What was shipped or fixed?
2. What was the original symptom or expected behavior?
3. Any known failure mode or edge case to cover?
4. Does this feature touch persisted structure (YAML, IndexedDB, server)? If yes → mandatory round-trip section.
5. Which views render this state (tree, panel, list, canvas, breadcrumb)? Each named view → one UI-≡-Model invariant in Class A.
6. Which **configured constraints** does this feature claim to respect (grid/snap, viewport, z-order/layer table, spacing tokens, theme tokens, density)? Each named constraint → one Class-E invariant. If none — say so explicitly.
7. *(Optional)* Local design reference images? Local files only.

Wait for the response before continuing.

### Step 2 — derive invariants before drafting commands

Before writing any `agent-view` call, list the invariants the feature must satisfy. For each, write one sentence in the form:
> "After any sequence of allowed actions, `<measurable property>` must hold."

This list seeds the `## Invariants` section. If you cannot articulate three invariants for a non-trivial feature, the feature is under-specified — ask the developer for clarification.

### Step 3 — draft the recipe

```markdown
# Verify: <feature or fix name>

Generated: <date>
Scope: <one sentence>

## Repro Steps
1. <Exact starting state>
2. <Action(s) that trigger the behavior under test>

## Narrowed Signal
`<agent-view command>` must return `<expected value>`.

## Invariants
<!-- Required. List each invariant the feature must maintain. -->

- **A1 (UI≡Model — <view name>):** `<eval expression that returns {model: N, dom: M, match: bool}>` must return `match: true`.
- **A2 (Hierarchy):** For each model node with `parentId === X`, its UI row must be a DOM-descendant of the UI row of `X`.
- **B1 (Round-trip):** After `location.reload()`, the projected signature `<projection>` is identical to the pre-reload signature.
- **B2 (No silent wrap-shift):** After `<wrap-creating action>`, `getWorldTransform(child).x === origWorldX(child)` for every wrapped child.
- **C1 (Single undo):** After `<action>`, `commandHistory.canUndo === true` and one `undo()` produces a signature identical to the pre-action signature.
- **D1 (No phantoms):** For each visible UI row of kind `<X>`, there exists exactly one model node it resolves to via its `nodeId` data-attribute (or the equivalent identifier).
- **E1 (Config conformance — <constraint name>):** Every rendered `<entity>` must satisfy `<conforms(rendered, configValue)>`, where `<configValue>` is read live from `<config source>` (do not hardcode). `offCount: 0` is required.

## Discipline

1. A failed `Expected:` line is FAIL, not "actually fine".
2. UI-vs-model mismatches are the bug; confirm by ancestry/bbox before dismissing.
3. Every `node.field` read in eval must be sentinel-checked (`isFinite` / `!== undefined`).
4. No hardcoded literal IDs; resolve by role at runtime.
5. Reload checkpoint is mandatory when the feature touches mutable structure.
6. Report `pass / fail / requires_visual_review` per step; failure prose belongs in the bug report only.
7. Do not pre-bake `requires_visual_review` as the planned status of a step. Every step ships with an executable `agent-view` path (at minimum a console-error gate around the action). The executor sets `requires_visual_review` only after a real attempt fails for a recorded reason.

## Evidence Commands

### 0. Setup — capture baseline signature
```bash
agent-view eval "<signature expression — projection of all structural fields>"
```
Stash the output as `BASELINE_SIG`.

### 1. <What this proves>
```bash
agent-view <command>
```
Expected: <concrete criterion>
Cost: ~<N> tokens

### 2. ... (one per action / invariant pair)

### N. Round-trip checkpoint (if applicable)
```bash
agent-view eval "location.reload()"
# wait for app to come back
agent-view eval "<same signature expression as step 0>"
```
Expected: identical to `BASELINE_SIG` after the action's expected effect is accounted for. Diff any drift.

## Positive-Case Assertions
- [ ] <criterion>

## Regression Checks
- [ ] <adjacent flow> — `agent-view <command>` → `<expected>`

## Design Conformance
<!-- Optional. Include ONLY if developer provided design refs. -->

| Step Label | Screenshot Command | Expected Reference |
|---|---|---|
| <area name> | `agent-view screenshot --crop "<area>" --scale 0.5` | `<absolute path>` |

Tolerance: `normal`.

## Anti-patterns avoided
- <recipe-specific traps>
```

### Step 4 — save the file

Determine a kebab-slug. Save to `.claude/verify-recipes/<slug>.md`. Create the directory first.

Confirm the path to the developer.

## Worked example: "added group component to scene editor"

**Developer input:**
> Added a group component that wraps multiple scene elements. Ctrl+G groups selected elements; Ctrl+Shift+G ungroups. Groups appear in the left tree panel as collapsible nodes. Groups are persisted in YAML.

**Recipe excerpt (Invariants + Round-trip — the parts that catch the bugs construction-only recipes miss):**

```markdown
## Invariants

- **A1 (UI≡Model, tree count):**
  ```
  agent-view eval "var sg=window.__editorCore.sceneGraph;var modelCount=0;sg.nodes.forEach(function(n){if(n.componentType==='group')modelCount++});var domCount=[...document.querySelectorAll('[role=treeitem]')].filter(function(e){return e.textContent.includes('Группа')}).length;JSON.stringify({modelCount:modelCount, domCount:domCount, match:modelCount===domCount})"
  ```
  must return `match: true`.

- **A2 (Tree hierarchy):**
  ```
  agent-view eval "var sg=window.__editorCore.sceneGraph;var violations=[];sg.nodes.forEach(function(n,id){if(n.componentType==='group'){n.childrenIds.forEach(function(cid){var domChild=document.querySelector('[data-node-id=\"'+cid+'\"]');var domParent=document.querySelector('[data-node-id=\"'+id+'\"]');if(domChild&&domParent&&!domParent.contains(domChild))violations.push({c:cid,p:id})})}});JSON.stringify({violations:violations.length})"
  ```
  must return `violations: 0`.

- **B1 (Round-trip after Ctrl+G + reload):**
  Capture signature, dispatch Ctrl+G, capture signature, reload, capture signature. The post-reload signature must equal the post-Ctrl+G signature *projected to the persisted fields*. Drift in `transform.x` of any wrapped child means the wrap path did not normalize coords.

- **B2 (No silent wrap-shift):**
  Before Ctrl+G: capture `getWorldTransform(child).x` for each leaf. After Ctrl+G: re-capture. Difference must be 0 (within float epsilon). Non-zero means the wrap action shifted the child in world space — a regression.

- **C1 (Single undo):**
  After Ctrl+G, `commandHistory.canUndo === true`. After one `undo()`, signature equals pre-Ctrl+G signature exactly.

- **D1 (No phantom group rows):**
  Same eval as A1; if the result is `modelCount: 1, domCount: 2`, that is a phantom-row bug. Confirm by `agent-view eval "[...document.querySelectorAll('span')].filter(e=>e.textContent==='Группа'&&e.children.length===0).map(e=>{var r=e.getBoundingClientRect();return{x:r.x,y:r.y}})"` — two adjacent rows in the same column = phantom.
```

This single example pair (A1 + D1 + B1 + B2) catches the three bugs from the 4.7 grouping session that the construction-only recipes missed.
