# How it works

```
┌──────────────┐    JSON over TCP        ┌─────────────────┐                 ┌──────────────┐
│  agent-view  │  (token-auth, local)    │  Lazy daemon    │      CDP        │   Your app   │
│     CLI      │ ──────────────────────▶ │  127.0.0.1:47922│ ──────────────▶ │  (Electron / │
│              │                         │                 │   WebSocket     │   Tauri /    │
│  one shot    │ ◀────────────────────── │  cache + reuse  │ ◀────────────── │   Chromium)  │
└──────────────┘    compact text         └─────────────────┘                 └──────────────┘
                                           ▲   spawned on first call
                                           │   shuts down after 5 min idle
                                           │   reuses one CDP socket across commands
```

The daemon is why `dom → click → dom` runs in ~17ms total: one persistent CDP socket, a 300ms AX-tree cache, parallel CDP calls inside `click`. CLI commands themselves are stateless. Each one is a single shell call you can drop into a script.

## Performance

Built for tight `dom → click → dom` loops. Typical Electron app, ~200 AX nodes:

| Scenario                       | agent-view | Playwright (estimate) |
|--------------------------------|------------|-----------------------|
| `dom` cold fetch               | 2ms        | ~30–80ms              |
| `dom` warm (cache hit)         | 1ms        | ~30–80ms              |
| Full cycle `dom → click → dom` | 17ms       | ~75ms                 |

What makes it fast: 300ms AX-tree cache (invalidated on `click`/`fill`/navigation; cached responses prefixed with `[cache]`), parallel CDP calls in `click`, `Accessibility.queryAXTree` for filter lookups, and a single persistent CDP WebSocket reused across commands (no relay).
