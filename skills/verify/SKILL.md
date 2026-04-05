---
name: verify
description: "Visual verification of desktop app UI after code changes. Use when modifying UI components, fixing visual bugs, testing user interactions, verifying layout, or when any workflow phase needs to inspect the running application. Triggers on: verify, check UI, test how it looks, visual regression, screenshot, inspect DOM."
allowed-tools: Bash(agent-view *)
---

# Visual Verification with agent-view

You have access to `agent-view` CLI for inspecting and interacting with desktop applications via Chrome DevTools Protocol.

## Prerequisites

The target project must have:
1. `agent-view.config.json` in project root (run `agent-view init` to generate)
2. CDP enabled in the app (e.g. `--remote-debugging-port=9222` for Electron)

If config is missing, run `agent-view init` first.

## Commands Reference

### Discovery & Launch
```bash
agent-view launch                      # Start app from config, wait for CDP readiness
agent-view discover                    # List windows (JSON) — get window IDs
agent-view stop                        # Stop the lazy server
```

### DOM Inspection
```bash
agent-view dom                          # DOM accessibility tree (default window)
agent-view dom --window <id|name>       # Specific window
agent-view dom --filter "button"        # Filter by text/role
agent-view dom --depth 3                # Limit tree depth
```

### Interaction
```bash
agent-view click <ref>                  # Click element by ref from dom output
agent-view click --pos 100,200          # Click by coordinates (for canvas)
agent-view fill <ref> "text"            # Type into input field
```

### Screenshots
```bash
agent-view screenshot                   # Save PNG to temp dir, print path
agent-view screenshot --window <id>     # Specific window
```

### Canvas / WebGL (only when `webgl` is configured in agent-view.config.json)

These commands read the scene graph from canvas-based rendering engines. Skip this section if the project has no `webgl` field in config.

```bash
agent-view scene                        # Scene graph from configured engine
agent-view scene --filter "player"      # Filter by object name/type
agent-view scene --verbose              # Extended props (scale, alpha, rotation)
agent-view scene --diff                 # Changes since last call
agent-view snap                         # DOM + Scene combined
```

## Verification Workflow

### Ad-hoc Mode (standalone)

After making code changes:

1. **Determine affected areas** from git diff
2. **Ensure app is running**: `agent-view launch` or `agent-view discover`
3. **Inspect DOM**: `agent-view dom --filter "<area>"` — check structure matches expectations
4. **Take screenshot**: `agent-view screenshot` — capture visual state
5. **Interact if needed**: `agent-view click`/`fill` → `agent-view dom` to verify state changed
6. **For canvas apps**: `agent-view scene --diff` to see what changed

### Scenario Execution Mode (from plan)

When UI scenarios are pre-generated (e.g., from a plan file with `## UI Scenarios` section):

1. **Read scenario steps** with symbolic refs (`$var` notation)
2. **Resolve each $var**: `agent-view dom --filter "<text>" --depth 3` → map to ref ID
3. **Execute steps** sequentially: fill, click, dom --filter (verify expected outcome)
4. **Screenshot**: capture on FAIL and at E2E scenario end — not every step
5. **Report per-scenario**: PASS / FAIL with reason and evidence

This mode works with any workflow that generates plan files with UI scenarios.

## Resilience

- **Stale refs:** After HMR, navigation, or state change — re-run `dom` for fresh refs before interacting
- **Element not found:** Wait 2s, retry once (render delay after HMR). If still missing — report FAIL
- **CDP disconnect:** Run `agent-view discover` to check. If no windows — `agent-view launch`
- **Max retries per command:** 2. After that — SKIP scenario step with warning

## Important Notes

- **Refs are session-scoped** — after HMR or navigation, run `dom` again for fresh refs
- **Multiple windows**: use `--window <id>` from `discover` output when titles overlap
- **Multiwindow**: all commands support `--window` flag
- **Output format**: plain text (DOM, scene), JSON (discover only), file path (screenshot)
- **Lazy server**: auto-starts on first call, shuts down after 5min idle
- **Token optimization**: always use `dom --filter` with specific text, limit `--depth` to 2-3
