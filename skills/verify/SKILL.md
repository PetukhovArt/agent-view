---
name: verify
description: Visual verification of desktop app UI after code changes. Use when modifying UI components, fixing visual bugs, or when asked to verify/check/test how the app looks. Works with Electron, Tauri, and browser apps via CDP.
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

### WebGL / PixiJS
```bash
agent-view scene                        # PixiJS scene graph
agent-view scene --filter "pump"        # Filter by object name
agent-view scene --verbose              # Extended props (scale, alpha, rotation)
agent-view scene --diff                 # Changes since last call
agent-view snap                         # DOM + Scene combined
```

## Verification Workflow

After making code changes:

1. **Determine affected areas** from git diff
2. **Ensure app is running**: `agent-view launch` or `agent-view discover`
3. **Inspect DOM**: `agent-view dom` — check structure matches expectations
4. **Take screenshot**: `agent-view screenshot` — capture visual state
5. **Interact if needed**: `agent-view click`/`fill` → `agent-view dom` to verify state changed
6. **For PixiJS apps**: `agent-view scene --diff` to see what changed on canvas

## Important Notes

- **Refs are session-scoped** — after HMR or navigation, run `dom` again for fresh refs
- **Multiple windows**: use `--window <id>` from `discover` output when titles overlap
- **Multiwindow**: all commands support `--window` flag
- **Output format**: plain text (DOM, scene), JSON (discover only), file path (screenshot)
- **Lazy server**: auto-starts on first call, shuts down after 5min idle
- **PixiJS**: requires `@pixi/devtools` initialized in the target app
