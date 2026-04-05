# agent-view

**Give your AI agent eyes and hands for desktop apps.**

AI coding agents can write code, run tests, and read logs — but they can't *see* what the app actually looks like. agent-view bridges that gap: it connects to any Chromium-based desktop app via Chrome DevTools Protocol and lets the agent inspect the UI, take screenshots, click buttons, and fill forms.

Built for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), but works with any AI agent or automation pipeline that can call CLI commands.

## Why CLI, not MCP?

Most alternatives in this space are MCP servers with 30+ tool definitions loaded into context on every session. That burns tokens before the agent even starts working.

agent-view is a CLI. One Bash call, compact text output, zero schema overhead. The accessibility tree comes back as plain text — not wrapped in JSON-RPC with metadata. For an agent that runs dozens of verification steps, the token savings add up fast.

And CLI works everywhere — Claude Code, Copilot, Codex, custom pipelines, CI. No MCP client required.

## Why

You're building an Electron app. Your AI agent just changed a login form. Did it break the layout? Is the button still clickable? Does the error message show up?

Without agent-view, you'd have to check manually. With agent-view:

```bash
agent-view dom --filter "login"        # See the DOM structure
agent-view screenshot                   # Capture what the user sees
agent-view fill 5 "admin@test.com"     # Type into an input
agent-view click 8                      # Click the submit button
agent-view screenshot                   # See what happened
```

The agent verifies its own changes — no human in the loop.

## Supported runtimes

| Runtime | Setup |
|---------|-------|
| **Electron** | `app.commandLine.appendSwitch('remote-debugging-port', '9222')` |
| **Tauri** | CDP via devtools configuration |
| **Any Chromium app** | `--remote-debugging-port=9222` launch flag |

## Install

```bash
npm install -g agent-view
```

## Quick start

```bash
cd your-electron-project

# 1. Generate config (auto-detects runtime, port, launch command)
agent-view init

# 2. Start your app (or let agent-view do it)
agent-view launch

# 3. See what's on screen
agent-view discover          # List all windows
agent-view dom               # Accessibility tree with ref IDs
agent-view screenshot        # PNG screenshot

# 4. Interact
agent-view click 5           # Click element by ref
agent-view fill 3 "hello"   # Type into input
```

## How it works

```
CLI → TCP → Lazy Server → CDP → Your App
```

A background server connects to your app's CDP port, caches sessions, and auto-shuts down after 5 minutes of inactivity. One server handles all projects, distinguished by CDP port.

## Config

Running `agent-view init` in your project root generates `agent-view.config.json`:

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
| `launch` | no | Command to start the app |
| `webgl.engine` | no | `"pixi"`, `"cesium"`, or `"three"` |

## Commands

### `init`

Auto-generates config by reading `package.json`.

### `discover`

Lists running app windows as JSON — window IDs, titles, URLs.

```bash
agent-view discover
```

### `dom`

Dumps the accessibility tree in compact text format. Each element gets a session ref ID for interaction.

```bash
agent-view dom
agent-view dom --filter "Submit"    # Filter by text/role
agent-view dom --depth 3            # Limit tree depth
agent-view dom --window "Settings"  # Target specific window
```

### `click`

Clicks a DOM element by ref ID or coordinates.

```bash
agent-view click 5                  # By ref from dom output
agent-view click --pos 100,200      # By coordinates (for canvas)
```

### `fill`

Types text into an input. Uses native value setter + dispatches input/change events (works with Vue, React, and other frameworks).

```bash
agent-view fill 3 "hello@example.com"
```

### `screenshot`

Captures a PNG screenshot, saves to temp dir, prints the file path.

```bash
agent-view screenshot
agent-view screenshot --window "Settings"
```

### `scene`

Reads the PixiJS scene graph via `window.__PIXI_DEVTOOLS__`. For apps with 2D canvas rendering.

```bash
agent-view scene                    # Full scene graph
agent-view scene --diff             # Changes since last call
agent-view scene --filter "player"  # Filter by name/type
agent-view scene --verbose          # Extended props (alpha, scale, bounds)
```

### `snap`

Combined DOM + scene graph in one call. Shows DOM always; scene section appears when PixiJS is detected.

```bash
agent-view snap
```

### `launch`

Starts the app using the `launch` command from config. Polls CDP until ready (60s timeout). Idempotent — skips if already running.

### `stop`

Stops the background lazy server.

## Multiwindow

All commands accept `--window` with either an ID (from `discover`) or a window title substring:

```bash
agent-view dom --window "Settings"
agent-view screenshot --window "About"
```

## Output format

| Command | Format | Why |
|---------|--------|-----|
| `dom`, `scene`, `snap` | Plain text | LLM-friendly, minimal tokens |
| `discover` | JSON | Machine-parseable |
| `screenshot` | File path | Agent reads the image |

## Claude Code plugin

agent-view ships as a Claude Code plugin with a built-in `verify` skill. The skill teaches Claude how to use agent-view for UI verification after code changes.

### Local development

```bash
claude --plugin-dir /path/to/agent-view
```

The skill becomes available as `/agent-view:verify`.

### After npm install

```bash
# Find where the package is installed
npm root -g
# Use that path with --plugin-dir
claude --plugin-dir "$(npm root -g)/agent-view"
```

## Example: testing a login flow

```bash
# Start the app
agent-view launch

# See the login page
agent-view dom --filter "login"
# RootWebArea "My App"
#   textbox "Email" [ref=3]
#   textbox "Password" [ref=5]
#   button "Sign in" [ref=7]

# Fill credentials and submit
agent-view fill 3 "admin@example.com"
agent-view fill 5 "password123"
agent-view click 7

# Verify — did we land on the dashboard?
agent-view dom --depth 2
agent-view screenshot
```

## License

MIT
