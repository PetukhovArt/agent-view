---
name: verify
description: "Visual verification of desktop app UI after code changes. Use when modifying UI components, fixing visual bugs, testing user interactions, verifying layout, or when any workflow phase needs to inspect the running application. Triggers on: verify, check UI, test how it looks, visual regression, screenshot, inspect DOM."
allowed-tools: Bash(agent-view *), Bash(rtk agent-view *)
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
rtk agent-view dom                          # DOM accessibility tree (default window)
rtk agent-view dom --window <id|name>       # Specific window
rtk agent-view dom --filter "button"        # Filter by text/role
rtk agent-view dom --depth 3                # Limit tree depth
```

### Interaction
```bash
agent-view click <ref>                  # Click element by ref from dom output
agent-view click --pos 100,200          # Click by coordinates (for canvas)
agent-view fill <ref> "text"            # Type into input field
```

### Screenshots
```bash
agent-view screenshot --scale 0.5              # Recommended: JPEG at half-res (~3× fewer vision tokens)
agent-view screenshot --scale 0.5 --window <id>  # Specific window
agent-view screenshot                          # Full-res PNG (expensive: ~19k tokens at 1920×1080)
```

### Scene / Canvas / WebGL (only when `webgl` is configured in agent-view.config.json)

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
3. **Inspect DOM**: `rtk agent-view dom --filter "<area>" --depth 2` — check structure matches expectations
4. **Interact if needed**: `agent-view click`/`fill` → `rtk agent-view dom --filter` to verify state changed
5. **For canvas apps**: `agent-view scene --diff` to see what changed
6. **Screenshot only for final visual confirm**: `agent-view screenshot --scale 0.5` — captures layout/styling that DOM can't reveal

### Scenario Execution Mode (from plan)

When UI scenarios are pre-generated (e.g., from a plan file with `## UI Scenarios` section):

1. **Read scenario steps** with symbolic refs (`$var` notation)
2. **Resolve each $var**: `agent-view dom --filter "<text>" --depth 3` → map to ref ID
3. **Execute steps** sequentially: fill, click, dom --filter (verify expected outcome)
4. **Screenshot**: `agent-view screenshot --scale 0.5` — only on FAIL and at E2E scenario end, not every step
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

## Token Optimization

Vision tokens dominate cost. One full-res screenshot ≈ 19k tokens (1920×1080, 12 tiles).

| Technique | Savings |
|---|---|
| `rtk agent-view dom --filter X --depth 2` | Compresses text output via RTK |
| `agent-view screenshot --scale 0.5` | ~3× fewer vision tokens (4 tiles) |
| `agent-view screenshot --scale 0.25` | ~12× fewer vision tokens (1 tile, ~1.6k tokens) |
| DOM-first: screenshot only for final visual confirm | Eliminates most screenshot calls |

**Default rule**: verify via `rtk agent-view dom --filter` first; only call `screenshot --scale 0.5` for final visual proof or layout bugs that DOM can't reveal.
