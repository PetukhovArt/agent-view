# 0010. Network capture of shared workers

- Status: Accepted
- Date: 2026-11-10

## Context

A `SharedWorker`'s `fetch` and XHR reach DevTools on the worker's own target only; a page session does not see them, so `network` printed `(no network activity)` for an app that talks to its server from a shared worker. Holding a session on that target changes how Chromium treats the worker, measured on Chrome 157 and Electron 43:

- While a client is attached, Chromium keeps the worker's DevTools host after the worker ends. A worker re-created with the same script URL and name gets the same target id and starts paused on `waitForDebugger` until the client sends `Runtime.runIfWaitingForDebugger`. A client that closes without it leaves the worker paused for good.
- Between `Inspector.targetCrashed` and the re-creation, a command to the session is held and run on the re-created worker (`Runtime.*`, `Log.enable`, `Network.enable` are answered then).
- `Network.getResponseBody` that reaches the browser after the worker ended kills the whole browser process (Electron exit `0x80000003`, Chrome likewise), at once and every time. Fetched at `loadingFinished`, as ADR 0002 does for pages, it races every end of the worker: a page reload, closing the last window, `self.close()`.

## Decision

- **Network capture attaches to `shared_worker` targets** as it does to pages and iframes, eagerly, and a rescan of the target list keeps the set current: a target that appears later joins without a new `network` call.
- **The session stays across a re-creation.** It resumes the worker on `Inspector.targetReloadedAfterCrash`, and sends `Runtime.runIfWaitingForDebugger` before it closes, so agent-view never leaves a worker paused.
- **A target missing from two rescans in a row is let go:** its session closes, its entries stay readable. The next worker, under a new id, is attached by the rescan.
- **A shared worker's response body is fetched on `--req`, not at `loadingFinished`,** and never after its worker ended. The request body comes with `requestWillBeSent` and needs no command.

## Alternatives

- **Eager response bodies, as for pages:** a body for every request, but a race against every end of the worker that kills the user's app. Rejected.
- **No response bodies for shared workers:** no risk, but the body is what a gateway's traffic is read for.
- **Close the session on `Inspector.targetCrashed`:** the re-created worker would start unpaused, but its first requests would be missed, and a close racing the re-creation leaves it paused for good.

## Consequences

- A worker re-created behind agent-view waits for one round trip to the lazy server before it runs.
- A shared worker's response body can be evicted by Chromium before `--req` asks for it; the detail then says `response body: unavailable: <why>`.
- Service workers and dedicated workers are still outside network capture.
