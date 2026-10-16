# 0008. A script lies in the area of its done condition

- Status: Accepted; supersedes the section rule of [ADR 0005](./0005-script-store-sections-and-use-cases.md)
- Date: 2026-10-08

## Context

ADR 0005 named sections after "product areas" and kept `integration/` for use cases that cross areas. Both left the section to judgment. In an Electron app a calling agent told `act-decider` "section `admin` (or a new `billing`)", grouping by topic; the decider obeys a given section over its own reading, and saved `billing-invoices-open`, whose done condition is `billing__invoices__…`, into `admin/`. "Crosses areas" does not separate anything either: the 12 use cases checked in a canvas-editor project pass through 2–6 sections (`project`, `tree`, `scene`, `files`) on the way to a check in `files`, and lie in `files/`.

## Decision

- **A step and a use case lie in the Area of their done condition**: the screen it sits on (a page, the workspace, the login window), not the component that renders it. A widget on the workspace lies in `workspace`. The areas passed through on the way do not count.
- **The Area is read from the done condition.** A test id whose segments follow the nesting names it in its first segment (`billing__invoices__…`); one rooted at a component (`chart-panel__grid`, a widget on the workspace) does not, and then the route or the screen title does.
- **No `integration/`.** A use case that crosses areas lies in the Area of its done condition, like any other.
- **The decider derives the section from the done condition.** A caller hands over the goal and the done condition, not a section; `--in` stays required and its value is the decider's reading.

## Alternatives

- **The server derives `--in` from the test id prefix.** Deterministic, but `area__…` is a convention of some projects, not of agent-view's users at large; a project with `login-button` ids or no ids gets nothing from it. Even the app above roots some widgets at the component (`chart-panel__grid` on the workspace).
- **A section-root key in `agent-view.config.json`, refusing a section with no directory under it.** Catches invented names only: `admin` is a real page of that app, so the misplacement above passes it. The canvas editor's sections (`tree`, `tabs`, `git`) do not mirror its directories.
- **Keep `integration/` under a clearer name.** Leaves the "does it cross areas" guess in place.

## Consequences

- Existing scripts stay where they are and still replay: a name is found in any section. `integration/` stores are moved into the Area of each use case's done condition by hand.
