# 0005. Script Store sections and use cases

- Status: Accepted; what an index line carries is superseded by [ADR 0006](./0006-store-index-is-for-picking-scripts-hold-no-uuid.md)
- Date: 2026-09-29

## Context

The flat Script Store of [ADR 0004](./0004-act-scripts-live-in-the-main-checkout.md) did not hold up on frontend FEA-10: 29 Act Scripts, 11 `.sh` steps with their own `lib.sh` / `run.sh` runner, and 0-step JSON "twins" of the shell steps so they showed in `act list` and could be named in `after` — `act replay tab-close` then printed DONE having done nothing. Steps went to shell because act had no way to act at a point of a canvas, scroll a panel instead of the viewport centre, or pick one of several identical controls, and because fixture setup touches files on disk. Older scripts of the same owner live elsewhere again, as `.mjs` under `.claude/features/`.

The owner's goal is a growing set of ready scenarios that later verifications replay instead of re-exploring. A scenario is a user's use case: it either stays inside one product area or crosses several, and it is built from small steps that other use cases reuse. One `after` prerequisite per script cannot express that — a step reused by two use cases after different steps, or twice in one use case with different parameters, needs a composition the step itself does not fix.

## Decision

- **One format.** The store holds Act Scripts and nothing that Replay cannot run. What forced shell becomes act ops (act at a point relative to an element, scroll the container of a row, the n-th of identical controls). No 0-step twins, no side runner.
- **Sections.** The store is split into subdirectories named after product areas (`auth/`, `libraries/`, `editor/canvas/`), mirroring the project, plus `integration/` for use cases that cross sections. There is no `shared/`: any step is reusable from wherever it lies, so nobody guesses reuse at save time and nothing moves when a second feature needs it. Saving requires `--in <section>`.
- **Names are store-wide.** A script is addressed by its name alone (`auth-login`), found in any section; the section is only where the file lies. Save refuses a name that exists in another section. Moving a file between sections breaks no reference.
- **Two kinds.** An Act Script recorded from an Act Session is a step. A **Use Case** is an ordered list of steps, each with its own parameter values (fixed, or `${NAME}` from env), and its own done condition; its name ends in `-use-case`, and save checks that the suffix matches the content. `act save-use-case` checks that every step exists and every parameter is bound. Inside a use case the steps' `after` is not run — the list is the whole order; `after` stays for replaying one step alone.
- **Waiting.** A long operation is waited on through the step's own done condition with a timeout set on the step and overridable per use-case entry. The signal stays DOM; network or console signals wait for a case the UI does not show.
- **Fixtures.** Setup on disk lives in `<section>/fixtures/`, is not an Act Script and is not listed. A use case names it in `requires`; Replay prints the reminder and never runs it — the store runs no arbitrary code (`allowEval` stays the only gate for that).
- **Indexes.** Every section gets a generated `index.md` with steps and use cases as two lists; the root `index.md` lists the sections. `act list` prints the root, `act list <section>` one section.

## Alternatives

- **Name is the path** (`shared/login`). Explicit, but promoting a step to another directory rewrites every `after` and use case that names it.
- **`shared/` + `features/<feature>/`.** The directory would encode a guess about reuse, made at every save and wrong whenever a second feature starts using a step.
- **Use case as an `after` chain.** Needs nothing new, but binds each step to one predecessor and one parameter set for the whole chain.
- **An escape-hatch `sh`/`eval` step inside the JSON.** One format on paper; in practice the easy path, and the formats spread again.

## Consequences

- Existing flat stores still replay: a script in the store root is found by name like any other. They are moved into sections by hand.
- The committed-or-not question of ADR 0004 is unchanged: the store stays gitignored until a team decides to share it.
