# 0001. Native Network capture over deferring to chrome-devtools-mcp

- Status: Accepted
- Date: 2026-06-15

## Context

`agent-view network` needs to give agents CDP `Network`-domain data (request/response timeline, headers, status, timing, bodies). Before building, we evaluated whether an existing tool — Google's `chrome-devtools-mcp` — could cover this instead.

`chrome-devtools-mcp` can attach to an already-running instance (`--browserUrl` / `--wsEndpoint` / `--autoConnect`), so the earlier assumption that ready-made tools "own the browser process" was wrong. The real discriminator is **runtime coverage**: `chrome-devtools-mcp` runs on `puppeteer-core`, and puppeteer's `connect()` is documented to fail against the runtimes agent-view targets:

- **Electron** — `Protocol error (Target.createTarget): Not supported`, `Target.getBrowserContexts: Not supported`. Electron's CDP target model diverges from Chrome's (electron#17776, electron#26637, puppeteer#3793).
- **Tauri** — WebView2 exposes only partial CDP; WebKit (macOS/Linux) is not CDP at all. puppeteer cannot drive either (strong prior, not independently verified — Electron alone settles the decision).

agent-view already speaks raw CDP via `chrome-remote-interface` (`src/cdp/transport.ts`) and ships per-runtime adapters for exactly these targets. The original product rationale (CLI over MCP) also stands: no 30+ tool schemas loaded into agent context per session, compact text instead of JSON-RPC, and usability from any shell-capable agent or CI.

## Decision

Build `agent-view network` natively on the raw CDP `Network` domain, through the existing `chrome-remote-interface` transport. Do not depend on or wrap `chrome-devtools-mcp`. No new runtime dependency.

## Alternatives

- **Defer to chrome-devtools-mcp** — its engine (`puppeteer-core`) cannot connect to Electron or Tauri, the runtimes agent-view exists to serve. `--browserUrl` attaches to Chrome, not to those runtimes. Rejected on runtime coverage.
- **Wrap chrome-devtools-mcp for the plain-Chromium case only** — splits the network surface across two tools and two output formats; plain Chromium is the lowest-value target (TODO roadmap calls it low-differentiation). Rejected: not worth the seam.
- **Adopt Playwright/Puppeteer directly** — same engine-level incompatibility plus they require owning the browser process. Rejected for the same reasons agent-view chose `chrome-remote-interface` originally.

## Consequences

- We own a new capture layer: `NetworkStream` modeled on `ConsoleStream` (per-target ring buffer, `drain(filter)`, `subscribe()`), a `handleNetwork` server handler, and a `network` CLI command.
- ServiceWorker / SharedWorker fetch capture becomes possible (attach `Network` on worker sessions) — a capability puppeteer-based tools handle poorly. Realizing it is in-scope follow-up work, not free.
- We carry the maintenance of mapping raw CDP `Network.*` events, including the response-body lifecycle constraint (`getResponseBody` only valid after `loadingFinished`, before buffer eviction) — see the body-capture decision recorded separately.
- Plain-Chromium users could alternatively reach for chrome-devtools-mcp; we accept that overlap rather than contort agent-view's surface to win that case.
