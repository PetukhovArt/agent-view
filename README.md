<div align="center">

<img src="https://raw.githubusercontent.com/PetukhovArt/agent-view/main/assets/logo.svg" width="72" alt="" />

# agent-view

**DevTools for AI agents. Electron, Tauri, Chromium.**<br/>
Your agent sees the DOM, state, console and network of a running app, and clicks through it like a user.

[![npm](https://img.shields.io/npm/v/@petukhovart/agent-view?label=npm&color=7aa2e0)](https://www.npmjs.com/package/@petukhovart/agent-view)
[![CI](https://github.com/PetukhovArt/agent-view/actions/workflows/ci.yml/badge.svg)](https://github.com/PetukhovArt/agent-view/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-66c29a)](LICENSE)

</div>

Agents read your code and your tests. They can't see whether the button is disabled, whether the modal opened or whether the store mutated. agent-view is one CLI that answers those questions over Chrome DevTools Protocol, for any agent that can run a shell command.

## Why agent-view

- **Real input.** `click`, `fill`, `key`, `drag` and `hover` fire CDP input events, so Vue `v-model`, React controlled inputs and native fields accept the value.
- **Compact output.** `dom` prints the accessibility tree with `[ref=N]` handles and test ids; `--compact`, `--diff` and `--count` keep it 40–60% smaller, `screenshot --crop --scale` does the same for images.
- **Workers and windows.** Console, network and state reach shared, service and dedicated workers; `--window` addresses settings, tray and detached windows the same as the main one.
- **Answers, not screenshots.** `watch` prints JSON-patches of any expression, `coverage` tells whether an action reached a function, `heap` diffs snapshots down to the detached DOM and its retainers.
- **Replayable flows.** `act` saves a path through the app and replays it in seconds without a model.
- **Fast.** A lazy daemon keeps one CDP socket and a 300 ms tree cache: `dom → click → dom` in about 17 ms.

## Quick start

```bash
npm install -g @petukhovart/agent-view
agent-view init                     # writes agent-view.config.json: runtime, CDP port, launch command
agent-view launch                   # starts the app and waits for CDP
agent-view dom --filter "Submit"    # accessibility tree with [ref=N] handles
agent-view click 12                 # a ref from the dom output
```

The app has to open a CDP port matching `port` in the config:

<details open><summary><b>Electron</b>: top of <code>main.ts</code>, before <code>app.whenReady()</code></summary>

```js
import { app } from 'electron';
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9876');
}
```
</details>

<details><summary><b>Tauri 2</b> (WebView2, Windows only)</summary>

```json
{ "scripts": { "dev": "cross-env WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9876 tauri dev" } }
```

On macOS and Linux Tauri embeds WebKit, which has no CDP.
</details>

<details><summary><b>Chromium</b></summary>

```bash
chromium --remote-debugging-port=9876
```
</details>

## Agents

| Where it runs | How to connect it |
|---|---|
| Claude Code | `/plugin marketplace add PetukhovArt/agent-view`, then `/plugin install agent-view@agent-view`: adds the `verify` skill and the `act-decider` agent ([workflow](docs/workflow.md)) |
| Codex, Cursor, Grok, OpenCode | Call the CLI from the shell; copy the gist of [`skills/verify/SKILL.md`](skills/verify/SKILL.md) into the agent's instructions ([other agents](docs/workflow.md#other-agents)) |

With the plugin, describe what must be true:

```text
Verify: after clicking Save, the button stays disabled until the request completes. No console errors.
```

<details><summary><b>Commands</b></summary>

| Command | What it gives the agent |
|---|---|
| `dom` | Accessibility tree with `[ref=N]` handles and test ids; `--filter`, `--compact`, `--count`, `--diff` |
| `click` / `hover` / `fill` / `key` / `drag` | Real CDP input; address by ref, `--testid` or `--selector` |
| `screenshot` | PNG, `--scale` or `--crop <element>` |
| `eval` / `watch` | Read JS state; stream JSON-patch diffs of an expression (needs `allowEval`) |
| `console` / `logs` | Console of pages and workers; a durable file feed that survives reloads |
| `network` | Requests, headers, timing, bodies, WebSocket and SSE frames, from page load on |
| `coverage` / `listeners` | Which functions ran; handlers on a node with their `file:line` |
| `heap` | Snapshot diff by class, detached DOM, retainers |
| `act` | Step protocol: reach a screen, save the path, replay it |
| `upload` / `dialog` / `wait` | File inputs, JS modals and file pickers, waiting for an element |
| `scene` / `snap` | WebGL scene graph (PixiJS, CesiumJS, any engine through a hook); DOM + scene in one call |
| `discover` / `targets` / `launch` / `init` / `stop` | Windows, targets and lifecycle |

Every flag: [commands](docs/commands.md).
</details>

## Docs

[Commands](docs/commands.md) · [Configuration and CDP](docs/configuration.md) · [Workflow](docs/workflow.md) · [How it works](docs/architecture.md) · [Troubleshooting](docs/troubleshooting.md) · [Changelog](CHANGELOG.md)

MIT © Artem Petukhov
