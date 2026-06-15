# 0002. Eager network capture lifecycle

- Status: Accepted
- Date: 2026-06-15

## Context

Two coupled lifecycle questions, both diverging from the `console` precedent or constrained by CDP:

1. **When does capture start?** `console` is lazy-attach — it subscribes on the first `console` call and anything emitted earlier is lost (documented). For network the most valuable traffic is page-load: initial XHR/fetch, auth handshakes, 404s on boot. Lazy-attach would routinely miss it and force a reload-then-recall dance.

2. **When is the response body fetched?** CDP `Network.getResponseBody` is only valid after `Network.loadingFinished` and before the body is evicted from the buffer. The agent only learns it wants a body at `network` call time — by then the body may be gone. A "lazy `--body` for past requests" model is therefore physically unworkable.

## Decision

Network capture is **eager on both axes**:

- `NetworkStream` attaches to targets at server `launch` / target `discover`, not on the first `network` call. Traffic is captured from app start.
- Response bodies are fetched **eagerly at `loadingFinished`** and stored (size-capped) in the ring entry — but only when the `captureBody` config flag is `true`. With `captureBody: false` (default), only metadata and headers are kept; no body is ever fetched.

## Alternatives

- **Lazy-attach (mirror `console`)** — one uniform pattern, less code, but loses page-load traffic; the agent must reload and recall. Rejected: network's value profile is front-loaded, unlike console.
- **Always fetch bodies** — every response body buffered regardless of need. Rejected: memory cost on body-heavy apps, and bodies carrying auth tokens/PII accumulate with no opt-in.
- **Lazy body fetch on `--req N`** — fetch only the body the agent asks for. Rejected: violates the CDP eviction constraint — the body is usually already evicted by call time, so it fails for exactly the past requests the agent is inspecting.

## Consequences

- The server runs network capture continuously while attached, costing memory proportional to the ring capacity (bounded; bodies dominate, so the network ring is smaller than console's 500).
- `captureBody` joins `allowEval` as a project-owner opt-in. Off by default keeps secret-bearing bodies out of agent context unless explicitly enabled.
- Eager attach means capture must survive navigation and re-attach to new targets as they appear — the server, not the CLI command, owns that lifecycle.
- Divergence from `console`'s lazy model must be documented in user-facing docs so the asymmetry is not read as a bug.
