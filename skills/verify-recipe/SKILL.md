---
name: verify-recipe
description: "Generates a concrete, command-by-command agent-view recipe for verifying a feature or bugfix. Use when the developer wants to write a verify-recipe.md, create a verification plan, build an agent-view recipe, or produce a verify checklist for a change they shipped. Triggers on: write a verify-recipe, write verification steps, generate verify steps for the feature/bug I just shipped/fixed, make a verify-recipe.md, what should I run to verify X, create a verification plan, agent-view recipe for this fix, verify checklist for this feature. Does NOT execute the checks — it authors the plan. For running checks against a live app, use the verify skill instead."
allowed-tools: Read, Write, Bash(agent-view *)
---

# Verification Recipe Generator

You help the developer author a disciplined, cheapest-first verification recipe for a feature they shipped or a bug they fixed. You do not run the checks — you produce a `.claude/verify-recipes/<slug>.md` file that any AI coding agent can execute later.

## What this produces

A file at `.claude/verify-recipes/<kebab-slug>.md` containing:

- **REPRO STEPS** — exact state the app must be in before checks run
- **NARROWED SIGNAL** — the measurable indicator that proves success or failure
- **EVIDENCE COMMANDS** — ordered `agent-view` calls, cheapest first, each annotated with what it proves
- **POSITIVE-CASE ASSERTIONS** — what "pass" looks like for each command
- **REGRESSION CHECKS** — adjacent paths that must not have broken

Create the directory if missing: `mkdir -p .claude/verify-recipes`

## Methodology

Frame the recipe with **hard-debug** discipline. That skill defines the chain: REPRO → narrowed signal → minimize scope → root-cause check → fix verification. Apply the same logic here in authoring mode:

1. Start from a reproducible starting state, not "open the app and poke around"
2. Convert vague expectations ("looks right") into measurable signals ("store.user.role === 'admin'")
3. Prefer the cheapest tool that can answer the question — a value check costs ~50 tokens, a screenshot costs ~6 000
4. Include at least one negative-case check (the old symptom must no longer appear)
5. Include at least one regression check (an adjacent flow must still work)

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
- Opening with a screenshot to "see the state" — use `dom --filter` or `eval` first
- Using `eval` when `dom --filter` answers the question
- Assertions that depend on transient state without `watch --until` to stabilize first
- "Check that it looks right" — every assertion must be a concrete pass/fail criterion

## Workflow

### Step 1 — gather context

When invoked, ask the developer in plain text (no tool calls yet):

1. What was shipped or fixed? (feature name or bug description)
2. What was the original symptom or expected behavior?
3. Any known failure mode or edge case to cover?

Wait for the response before continuing.

### Step 2 — draft the recipe

Use the answers to produce a recipe with these sections:

```markdown
# Verify: <feature or fix name>

Generated: <date>
Scope: <one sentence describing what this covers>

## Repro Steps
1. <Exact starting state — window open, user logged in, specific route, etc.>
2. <Action(s) that trigger the behavior under test>

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

## Anti-patterns avoided
- <note any recipe-specific traps, e.g. "state resets on reload — watch needed before dom check">
```

### Step 3 — save the file

Determine a kebab-slug from the feature/fix name (e.g. `login-redirect-fix`, `cart-total-display`).

Save to `.claude/verify-recipes/<slug>.md`. Create the directory first if it doesn't exist.

Confirm the path to the developer.

## Worked example: "fixed login redirect bug"

**Developer input:**
> Fixed a bug where after login, the redirect went to `/home` instead of `/dashboard`. Store mutation `SET_REDIRECT_PATH` was missing. No visual change — purely a routing issue.

**Recipe produced:**

```markdown
# Verify: Login Redirect Fix

Generated: 2026-04-27
Scope: Confirms that a successful login routes to /dashboard, not /home, and that the store mutation fires correctly.

## Repro Steps
1. App running, user logged out, at `/login`
2. Fill email + password, click "Sign in"

## Narrowed Signal
`agent-view eval "router.currentRoute.path"` must return `"/dashboard"`.

## Evidence Commands

### 0. Setup — baseline console (before any action)
```bash
agent-view console --clear
```

### 1. Confirm redirect target
```bash
agent-view fill <email-ref> "admin@example.com"
agent-view fill <password-ref> "password"
agent-view click <signin-ref>
agent-view watch "router.currentRoute.path" --until "router.currentRoute.path === '/dashboard'"
```
Expected: `replace /  "/login" → "/dashboard"` in watch output
Cost: ~100 tokens

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

### 4. Regression — logout returns to /login
```bash
agent-view click <logout-ref>
agent-view eval "router.currentRoute.path"
```
Expected: `"/login"`
Cost: ~60 tokens

## Positive-Case Assertions
- [ ] `router.currentRoute.path` === `/dashboard` after login
- [ ] `store.state.auth.redirectPath` === `/dashboard`
- [ ] No console errors during the flow

## Regression Checks
- [ ] Logout → `/login` still works

## Anti-patterns avoided
- Not using screenshot to confirm route (route is a string — eval is 120× cheaper)
- watch used before eval so route change is confirmed to have settled, not just sampled mid-transition
```

**Saved to:** `.claude/verify-recipes/login-redirect-fix.md`
