# Configuration

Running `agent-view init` in your project root generates `agent-view.config.json`. Every other command locates it by walking up from the current directory (like git looks for `.git`), so commands work from any subdirectory of the project; the config's directory is what `launch` uses as the app's working directory.

Minimal form:

```json
{
  "runtime": "electron",
  "port": 9876,
  "launch": "npm run dev"
}
```

Full form with all optional fields:

```json
{
  "runtime": "electron",
  "port": 9876,
  "launch": "npm run dev",
  "allowEval": true,
  "webgl": {
    "engine": "pixi"
  },
  "consoleBufferSize": 500,
  "consoleTargets": ["page", "shared_worker", "service_worker"],
  "captureBody": false,
  "networkBufferSize": 200,
  "logFile": ".agent-view/console.log",
  "logMaxBytes": 8388608,
  "testIdAttribute": "data-testid"
}
```

| Field               | Required | Description                                                                                                                                           |
|---------------------|----------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| `runtime`           | yes      | `"electron"`, `"tauri"`, or `"browser"`                                                                                                               |
| `port`              | yes      | CDP debugging port. Integer in range `1`–`65535`                                                                                                      |
| `launch`            | yes      | Shell command used by `agent-view launch` to start the app (e.g. `"npm run dev"`). Pass an empty string if you always start the app yourself          |
| `webgl.engine`      | no       | Scene-graph engine: `"pixi"`, `"cesiumjs"`, or `"app-hook"` for any other engine, where the app exposes its scene through `window.__AGENT_VIEW_SCENE__`. Set by hand; `init` detects only `pixi` |
| `allowEval`         | no       | `true` to enable `agent-view eval`, `watch`, `logs --probe` and `act` expressions (`--until-expr`, `wait --expr`). Off by default; opt-in for arbitrary JS execution |
| `consoleBufferSize` | no       | Per-target console ring capacity. Positive integer. Default `500`                                                                                     |
| `consoleTargets`    | no       | Target types `agent-view console` auto-attaches to on first call. Any subset of `["page", "iframe", "shared_worker", "service_worker", "worker"]`. Default `["page", "shared_worker", "service_worker"]` |
| `captureBody`       | no       | `true` to capture response bodies and request payloads for `agent-view network`. Off by default; opt-in since bodies can carry tokens/PII. WebSocket frame payloads are visible regardless              |
| `networkBufferSize` | no       | Per-target network ring capacity. Positive integer. Default `200` (smaller than console — entries are heavier)                                                                                         |
| `logFile`           | no       | Feed file for `agent-view logs`. Relative paths resolve against the project root. Default `.agent-view/console.log` (gitignore it). Keep it per-checkout: two ports recording into one file is refused                                                                     |
| `logMaxBytes`       | no       | Feed size cap in bytes; on overflow it rotates once to `<file>.prev`. Default `8388608` (8 MB)                                                                                                         |
| `testIdAttribute`   | no       | Attribute holding the project's test ids, shown by `dom` and matched by `--testid`. Default: `data-testid`, `data-test-id`, `data-test`, `data-qa` and `data-cy` are all read. Setting it reads only that one |

## Enabling CDP

agent-view talks to your app over Chrome DevTools Protocol. Your app must be launched with a debugging port open.

### Recommended: in code (reliable, works with any build tool)

Add to your Electron main process, **before `app.whenReady()`** (top of `main.ts`/`main.js`, right after the `electron` import; switches set after the app is ready are ignored):

```js
import { app } from 'electron';

app.commandLine.appendSwitch('remote-debugging-port', '9876');
```

> Any free port works; `9876` is just an example. Avoid `9222` (Chrome's own default remote-debugging port) to prevent collisions when Chrome is open.

**Production safety:** an open CDP port in a signed/notarized build is a remote-code-execution surface. Gate it on `!app.isPackaged` so it only opens in dev:

```js
if (!app.isPackaged) {
    app.commandLine.appendSwitch('remote-debugging-port', '9876');
}
```

### Alternative: via CLI flag (no code changes)

```bash
# Plain Electron
electron . --remote-debugging-port=9876

# electron-vite (note the -- to forward the flag past the build tool)
npx electron-vite dev -- --remote-debugging-port=9876
```

### Other runtimes

| Runtime              | Setup                                      |
|----------------------|--------------------------------------------|
| **Tauri (Windows)**  | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9876` on `tauri dev` (via `cross-env` in the dev script). Devtools must be on in `tauri.conf.json` (default in `tauri dev`; release builds need the `devtools` Cargo feature). WebKit builds (macOS/Linux) are not supported |
| **Any Chromium app** | `--remote-debugging-port=9876` launch flag |

### Verify CDP is working

```bash
curl -s http://localhost:9876/json/version
```

A JSON response with process info means CDP is reachable.
