# agent-view — Visual Verification for Desktop Apps

CLI tool for inspecting and interacting with desktop applications (Electron/Tauri/Browser) via Chrome DevTools Protocol.

## When to use

After making UI changes in a desktop app project, use agent-view to verify the result visually — check DOM state, take screenshots, interact with elements.

## Prerequisites

The target project must have `agent-view.config.json` (run `agent-view init` to generate).
The app must expose a CDP port (e.g. `--remote-debugging-port=9222`).

## Workflow

### 1. Ensure app is running
```bash
agent-view launch          # Starts app from config, waits for CDP readiness
agent-view discover        # Lists windows (JSON) — use to get window IDs
```

### 2. Inspect UI state
```bash
agent-view dom                          # DOM accessibility tree (main window)
agent-view dom --window <id|name>       # Specific window
agent-view dom --filter "button"        # Filter by text/role
agent-view dom --depth 3                # Limit tree depth
agent-view screenshot                   # Save PNG to temp dir
agent-view screenshot --window <id>     # Specific window
```

### 3. Interact with UI
```bash
agent-view click <ref>                  # Click element by ref from dom output
agent-view click --pos 100,200          # Click by coordinates (for canvas)
agent-view fill <ref> "text"            # Type into input field
```

### 4. WebGL inspection (PixiJS)
```bash
agent-view scene                        # PixiJS scene graph
agent-view scene --filter "pump"        # Filter by object name
agent-view scene --verbose              # Extended properties (scale, alpha, rotation)
agent-view scene --diff                 # Changes since last call
agent-view snap                         # DOM + Scene combined
```

### 5. Cleanup
```bash
agent-view stop                         # Stop the lazy server
```

## Verification pattern

After changing code in a desktop app:

1. Determine affected UI areas from git diff
2. `agent-view dom` — check DOM structure matches expectations
3. `agent-view screenshot` — capture visual state
4. If interactive change: `agent-view click`/`fill` → `agent-view dom` again to verify state changed
5. For PixiJS apps: `agent-view scene --diff` to see what changed

## Key details

- Refs are session-scoped — after HMR or navigation, run `dom` again to get fresh refs
- All commands support `--window <id|name>` for multiwindow apps
- When multiple windows share the same title, use the full ID from `discover`
- `dom` output: plain text, ~1500 tokens for typical page
- `screenshot` returns file path to PNG
- `scene` requires `@pixi/devtools` initialized in the target app
- Lazy server auto-starts on first CLI call, shuts down after 5min idle
