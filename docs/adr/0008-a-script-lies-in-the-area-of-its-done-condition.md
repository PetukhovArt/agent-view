# 0008. A script lies in the area of its done condition

- Status: Accepted; supersedes the section rule of [ADR 0005](./0005-script-store-sections-and-use-cases.md)
- Date: 2026-10-08

## Context

ADR 0005 named sections after "product areas" and kept `integration/` for use cases that cross areas. Both left the section to judgment. On web-client a calling agent told `act-decider` "section `admin` (or a new `license`)", grouping by topic; the decider obeys a given section over its own reading, and saved `license-trassir-open`, whose done condition is `license-server__configuration__…`, into `admin/`. "Crosses areas" does not separate anything either: the 12 frontend use cases checked pass through 2–6 sections (`project`, `tree`, `scene`, `library`) on the way to a library check, and lie in `library/`.

## Decision

- **A step and a use case lie in the Area of their done condition**: the screen it sits on (a page, the workspace, the login window), not the component that renders it. A widget on the workspace lies in `workspace`. The areas passed through on the way do not count.
- **The Area is read from the done condition.** A test id whose segments follow the nesting names it in its first segment (`license-server__configuration__…`); one rooted at a component (`video-panel__grid`, a widget on the workspace) does not, and then the route or the screen title does.
- **No `integration/`.** A use case that crosses areas lies in the Area of its done condition, like any other.
- **The decider derives the section from the done condition.** A caller hands over the goal and the done condition, not a section; `--in` stays required and its value is the decider's reading.

## Alternatives

- **The server derives `--in` from the test id prefix.** Deterministic, but `area__…` is a convention of some projects, not of agent-view's users at large; a project with `login-button` ids or no ids gets nothing from it. Even web-client roots some widgets at the component (`video-panel__grid` on the workspace).
- **A section-root key in `agent-view.config.json`, refusing a section with no directory under it.** Catches invented names only: `admin` is a real page of web-client, so the misplacement above passes it. Frontend sections (`tree`, `tabs`, `git`) do not mirror its directories.
- **Keep `integration/` under a clearer name.** Leaves the "does it cross areas" guess in place.

## Consequences

- Existing scripts stay where they are and still replay: a name is found in any section. `integration/` stores are moved into the Area of each use case's done condition by hand.
