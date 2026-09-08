# Claude Code Instructions

agent-view is a CLI that gives AI agents DevTools-level access to any Chromium-based desktop app over Chrome DevTools
Protocol (CDP).

## Commands

```bash
pnpm test     # vitest run
pnpm build    # tsc — also the typecheck; `prepublishOnly` runs it
```

The published binary is `dist/cli/index.js` (`bin: agent-view`).

<important if="you are running or changing the bench harness">

Bench harness lives in `bench/` with its own Electron app under `bench/app/`. Four entry points:

```bash
npx tsx bench/smoke-devtools.ts   # end-to-end CDP / console / SharedWorker smoke
npx tsx bench/smoke-dialogs.ts    # modals: JS dialog auto-answer, upload, file-chooser arm
npx tsx bench/smoke-reach.ts      # coverage delta + listeners over real CDP
npx tsx bench/run.ts              # token / latency benchmark across scenarios
```

Each smoke stops whatever server holds port 47922 before starting its own — a leftover server keeps serving the code it
was started with and produces failures the current source does not have.

</important>

## Architecture

The whole runtime is one process model:

```
CLI command  →  TCP (127.0.0.1:47922, token-auth)  →  Lazy server  →  CDP  →  Target app
```

The lazy server self-spawns on first call and shuts down after 5 min idle. CLI commands never talk to CDP directly —
they always go through the server so the CDP WebSocket and AX tree cache are reused across calls.

### Layers (read in this order to grok the codebase)

1. **`src/cdp/types.ts`** — two session kinds:
    - `RuntimeSession` — `Runtime` + `Console` + `Log` only. Created by `connectToRuntime`. Used for `shared_worker` /
      `service_worker` / `worker` targets.
    - `PageSession extends RuntimeSession` — adds `Page` / `DOM` / `Accessibility` / `Input`. Created by
      `connectToPage`. Used for `page` / `iframe` targets. The interface inheritance is load-bearing — anything
      accepting `RuntimeSession` works for pages too; the type system enforces that screenshot/DOM ops cannot be
      requested on a worker.

2. **`src/cdp/transport.ts`** — the CDP boundary. Two factories above; `listSupportedTargets` enumerates and filters to
   known `TargetType`s. Console subscription is registered **before** `Runtime.enable` / `Log.enable` so buffered
   messages aren't dropped. CDP host map (`127.0.0.1` vs `::1`) is per-target — Tauri/WebView2 sometimes only listen on
   IPv6.

3. **`src/server/server.ts`** — single TCP server. Owns:
    - **Session cache** — keyed `port:targetId`, so state is scoped to the CDP port, not global. `getPageSession` /
      `getRuntimeSession` reuse or create.
    - **`ConsoleStream`** (`src/cdp/_tests/console-stream.ts`) — multi-target ring buffer. `console` is **lazy-attach**:
      first call attaches matching targets (filtered by `consoleTargets` config). Anything emitted before the first call
      is lost.
    - **`NetworkStream`** (`src/cdp/network-stream.ts`) — the deliberate opposite: **eager**, attached in
      `handleLaunch`, not on the first `network` call, so page-load traffic isn't missed.
      See [ADR 0002](./docs/adr/0002-eager-network-capture-lifecycle.md).
    - **`AxTreeCache`** — short-TTL cache, invalidated on `Page.frameNavigated` and after `click`/`fill`.
    - **`WatchSession`** (`server/watch-session.ts`) — `watch <expr>` polls a JS expression and emits RFC-6902
      JSON-patch diffs; pairs with `inspectors/watch/`.
    - **`RefStore`** (`server/ref-store.ts`) — allocates the `[ref=N]` handles printed by `dom`/`scene`. `dom --count`
      and `dom --diff` deliberately bypass it (no mutation / ref-normalised compare).
    - **Token auth** at `~/.agent-view/token`, idle shutdown, 1 MB request cap.

4. **`src/cli/`** — thin shells. `cli/index.ts` registers commander commands; `cli/commands/*.ts` opens a TCP socket to
   the server and writes a `ServerRequest` JSON line. No business logic here.

5. **`src/adapters/`** — per-runtime config (`electron`, `tauri`, `browser`). Each returns a `PageSession` via
   `listSupportedTargets` + `connectToPage`. Add new runtimes by registering in `adapters/registry.ts`.

6. **`src/inspectors/`** — pure formatters (DOM tree → compact text, scene graph extractors). `scene/` is
   engine-pluggable (currently PixiJS via `window.__PIXI_DEVTOOLS__`).

<important if="you are changing what a command may execute, capture, or store">

### Security gates

Two flags in `agent-view.config.json` are **project-owner opt-ins**, both off by default. The token already
authenticates the local socket; these gate what the socket is allowed to do. Don't bypass either.

- **`allowEval`** — `eval` is the only command that runs arbitrary JS; `watch` and `logs --probe` are gated by the same
  flag. Enforced in `src/server/server.ts` (`handleEval`).
- **`captureBody`** — response bodies are fetched eagerly at `loadingFinished` and kept in the ring only when this is
  `true`. Off, only metadata and headers are stored, so secret-bearing bodies stay out of agent context.

</important>

<important if="you are adding, moving, or renaming a test file">

### Test layout

Two layouts coexist: `src/cdp/`, `src/adapters/` and most of `src/inspectors/` put tests in `_tests/` (or `_tests_/`)
sibling directories; `src/server/` and `src/config/` colocate them next to the source. Match the directory you are in.
`tsconfig.json` excludes `**/*.test.ts` from the build.

`src/cdp/_tests/console-stream.ts` is source, not a test — the server imports it from there.

</important>

## Conventions enforced in this repo

- **Console is lazy-attach**: `console` has no back-buffer, so any doc or skill describing it must teach
  `clear → act → check` (see `skills/verify/SKILL.md`). This is a console rule, not a house rule for every stream —
  network attaches eagerly on purpose ([ADR 0002](./docs/adr/0002-eager-network-capture-lifecycle.md)). A new per-target
  stream picks its lifecycle from where its value sits, and records the choice as an ADR.
- **Adapters return `PageSession`**, not raw CDP clients. Don't leak `chrome-remote-interface` types past `src/cdp/`.
- **`dist/`** is gitignored but published — `pnpm build` runs from `prepublishOnly` only, never commit the output.

## Reference docs in repo

- [`GLOSSARY.md`](./GLOSSARY.md) — domain glossary (Target / Session / Console Stream / `allowEval`). Single source of
  truth for naming.
- [`docs/adr/`](./docs/adr/) — accepted architecture decisions. Read before reversing a lifecycle or capture choice.
- `skills/verify/SKILL.md` — how an agent should *use* agent-view (DOM-first workflow, tool-selection table, execution
  discipline). Per-command flags and output contracts live one level down in
  `skills/verify/references/commands.md` — **that** is the file to edit when you change CLI surface or output text, and
  agent UX depends on the exact strings in it.
- `CHANGELOG.md` — canonical for release notes. Every shipped feature lands here.

## Releasing

A version bump landing on `main` *is* the release. Write the `## [x.y.z]` section in `CHANGELOG.md`, run
`npm version <major|minor|patch>` (the `version` hook syncs `.claude-plugin/plugin.json`), then push.
`.github/workflows/release.yml` publishes to npm, creates the tag and writes the GitHub release with that
CHANGELOG section as its body. A missing CHANGELOG section fails the run before `npm publish`.
