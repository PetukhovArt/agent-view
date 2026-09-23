# 0003. Act step protocol and replay

- Status: Accepted
- Date: 2026-09-23

## Context

Driving a UI scenario with the regular commands costs a strong model 20–30 turns: `dom` to find refs, `click`/`fill`, `wait`, re-`dom` after refs go stale. Measured on web-client (Electron, MW login and "add a GIS widget next to the video panel"): Opus via `cdp-verifier` took 146 s / $0.35 and 376 s / $0.45. Each turn replays the whole context, so the bill is turns × context, and the model spends most turns re-deriving what the tool could decide.

A cheap model can pick "which control next" if every call answers with a small numbered table and the tool does everything deterministic. agent-view cannot call a model itself (no API key, no SDK in the package), so the loop has to be driven from outside — by whatever reads the table.

## Decision

A server-side **Act Session** per CDP port, driven over the CLI:

- `act start --until-testid <id>` (or `--until-selector`, exactly one — a run without a done condition is refused) prints a **Control Table** — visible interactive controls and named `alert`/`status` notices, numbered, with role, name, value, states and test id; password values masked.
- Each **Act Step** (`act click|type|select|drag|scroll|do …`) is one CLI call that re-snapshots, maps row n from the last printed table (stale guard: same node, else unique role|name|testid match, else BLOCKED), hit-tests, acts, settles by polling instead of sleeping, checks the until condition, and prints DONE or the next table.
- Done is checked by agent-view, never taken from the model.
- The run is recorded by test id, else role + name — never by row number — and `act save` / `start --save` writes it as JSON. `act replay` re-runs it inside the server with no model: each step waits only for its own control, then acts. Exit 0 DONE, 1 FAIL (until never came, or a control stayed disabled or covered), 3 STALE (a control is gone — re-record), 2 when the replay could not run.

The **Decider** — whatever turns a table into `op n [text]` — is not part of agent-view. The first one is a Claude Code subagent shipped with the plugin (`agents/act-decider.md`); later a dedicated calibrator can take its place without changing the protocol.

## Alternatives

- **Decider inside agent-view (API call from the server)** — fastest per step, but puts a model key and an SDK dependency into a local debugging tool. Rejected for the prototype; the CLI protocol leaves the door open to an external process that does exactly this.
- **Bash replay script of existing commands** (first prototype) — zero new code for replay, but one node process per step, 500 ms `wait` polls, no way to ride over a window reload, and no STALE/FAIL split. Replaced by in-server replay.
- **Only improve the regular commands** — testid addressing already shipped; it still leaves the strong model deciding every step.

## Consequences

- Measured on the same two scenarios: a Sonnet 5 decider (`effort: low`) 9.7 s / $0.044 for the widget; replay 0.6–1.2 s widget, 1.8–2.0 s login (0.1–0.2 s of it ours, the rest the app), $0.
- Harness overhead dominates a subagent decider: an auto-mode permission classifier added 2–4 s per Bash call; Haiku 4.5 cannot turn thinking off (~3 s per turn). The decider definition therefore pins Sonnet at low effort.
- A recording captures the state it started from: fields already filled and toggles already open are not replayed. STALE is the signal to re-record, not a bug to patch in the script.
- Pointer-only elements (a `div` with a pointer handler and no role) join the table as `item` rows only when they carry a test id and `cursor: pointer` and do not sit inside a control (`cursor` is inherited); untagged ones stay invisible to a decider.
- New state on the server (`PortState.act`) and a second server port option (`AGENT_VIEW_SERVER_PORT`, with a per-port token file) so a dev build can run beside the installed one.
