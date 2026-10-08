# 0008. A script lies in the area of its goal

- Status: Accepted; supersedes the section rule of [ADR 0005](./0005-script-store-sections-and-use-cases.md)
- Date: 2026-10-08

## Context

ADR 0005 named sections after "product areas" and kept `integration/` for use cases that cross areas. Both left the section to judgment. On web-client a calling agent told `act-decider` "section `admin` (or a new `license`)", grouping by topic; the decider obeys a given section over its own reading, and saved `license-trassir-open`, whose goal is `license-server__configuration__…`, into `admin/`. "Crosses areas" does not separate anything either: every frontend use case passes through 2–6 sections (`project`, `tree`, `scene`, `library`) on the way to a library check, and lies in `library/`.

## Decision

- **A step and a use case lie in the area of their goal**: the screen area their done condition names. The areas it passes through on the way do not count. With test ids named `area__block__element` that area is the first segment; otherwise the route or the screen the condition sits on.
- **No `integration/`.** A use case that crosses areas lies in the area its done condition checks, like any other.
- **The decider derives the section from the goal.** A caller hands over the goal and the done condition, not a section; `--in` stays required and its value is the decider's reading of the goal.

## Alternatives

- **The server derives `--in` from the test id prefix.** Deterministic, but `area__…` is a convention of some projects, not of agent-view's users at large; a project with `login-button` ids or no ids gets nothing from it.
- **A section-root key in `agent-view.config.json`, refusing a section with no directory under it.** Catches invented names only: `admin` is a real page of web-client, so the misplacement above passes it. Frontend sections (`tree`, `tabs`, `git`) do not mirror its directories.
- **Keep `integration/` under a clearer name.** Leaves the "does it cross areas" guess in place.

## Consequences

- Existing scripts stay where they are and still replay: a name is found in any section. `integration/` stores are moved into the area of each use case's goal by hand.
