# agent-view

CLI tool for visual verification of desktop apps (Electron, Tauri, or any Chromium-based app) via Chrome DevTools Protocol.

Designed for AI agents that need to **see and interact** with desktop UIs — closing the loop between "wrote code" and "visually verified."

## How it works

```
CLI (commander) → TCP → Lazy Server → CDP → Your App
```

A background server connects to your app's CDP port, caches sessions, and auto-shuts down after 5 minutes of inactivity. One server handles all projects, distinguished by CDP port.

## Install

```bash
npm install -g agent-view
```

## Quick start

```bash
cd your-electron-project

# Generate config from package.json
agent-view init

# Launch the app (if not running)
agent-view launch

# List windows
agent-view discover

# Get accessibility tree
agent-view dom

# Take a screenshot
agent-view screenshot
```

## Setup

Your app must expose a CDP debugging port. For Electron, add to your main process (dev only):

```js
app.commandLine.appendSwitch('remote-debugging-port', '9222');
```

Then run `agent-view init` in your project root — it auto-detects runtime, port, and launch command from `package.json`.

### Config file

`agent-view.config.json` in your project root:

```json
{
  "runtime": "electron",
  "port": 9222,
  "launch": "npm run dev"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `runtime` | yes | `"electron"`, `"tauri"`, or `"browser"` |
| `port` | yes | CDP debugging port |
| `launch` | no | Command to start the app (used by `launch`) |
| `webgl.engine` | no | `"pixi"`, `"cesium"`, or `"three"` |

## Commands

### `init`

Auto-generates `agent-view.config.json` by reading `package.json`.

### `discover`

Lists running app windows as JSON.

```bash
agent-view discover
```

### `dom`

Dumps the accessibility tree in compact text format with session ref IDs.

```bash
agent-view dom
agent-view dom --filter "Submit"
agent-view dom --depth 3
agent-view dom --window 1
```

| Flag | Description |
|------|-------------|
| `-f, --filter <text>` | Filter nodes by text |
| `-d, --depth <n>` | Limit tree depth |
| `-w, --window <id\|name>` | Target specific window |

### `click`

Clicks a DOM element by session ref ID or coordinates.

```bash
agent-view click 5
agent-view click --pos 100,200
```

| Flag | Description |
|------|-------------|
| `-p, --pos <x,y>` | Click by coordinates (for canvas) |
| `-w, --window <id\|name>` | Target specific window |

### `fill`

Sets input value with native setter + dispatches input/change events (works with frameworks like Vue/React).

```bash
agent-view fill 3 "hello@example.com"
```

| Flag | Description |
|------|-------------|
| `-w, --window <id\|name>` | Target specific window |

### `screenshot`

Captures a PNG screenshot, saves to temp dir, prints the file path.

```bash
agent-view screenshot
agent-view screenshot --window "Settings"
```

### `scene`

Reads the PixiJS scene graph via `window.__PIXI_DEVTOOLS__`.

```bash
agent-view scene
agent-view scene --verbose
agent-view scene --diff
agent-view scene --filter "player"
```

| Flag | Description |
|------|-------------|
| `-f, --filter <text>` | Filter by name or type |
| `-d, --depth <n>` | Limit tree depth |
| `-v, --verbose` | Extended properties (alpha, scale, rotation, bounds) |
| `--diff` | Show only changes since last call |
| `-w, --window <id\|name>` | Target specific window |

### `snap`

Combined DOM + scene graph output in one call. Shows DOM always; scene section only when PixiJS is detected.

```bash
agent-view snap
```

Accepts the same flags as `dom` and `scene` (except `--diff` and `--verbose`).

### `launch`

Starts the app using the `launch` command from config. Polls CDP until ready (60s timeout). Idempotent — if already running, prints status and exits.

```bash
agent-view launch
```

### `stop`

Stops the background lazy server.

```bash
agent-view stop
```

## Multiwindow support

All interaction commands accept `--window` with either a numeric ID (from `discover`) or a window title substring.

## Output format

- `dom`, `scene`, `snap` — plain text (LLM-friendly)
- `discover` — JSON
- `screenshot` — file path

## License

MIT
