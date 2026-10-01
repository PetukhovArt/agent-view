# 0006. The store index is for picking a script; scripts hold no uuid

- Status: Accepted
- Date: 2026-10-01

## Context

[ADR 0004](./0004-act-scripts-live-in-the-main-checkout.md) put in the index what lets an agent pick a script without replaying it: the note, the start route, the `after` prerequisite. [ADR 0005](./0005-script-store-sections-and-use-cases.md) added the until and a use case's step chain. On frontend FEA-10 the `library` section index grew to 46 KB, with lines up to 1400 characters. The full until took 18 % of the file, and the notes held preconditions, file checks, md5 sums, uuids, coordinates and code links. To pick one script, an agent had to read all of it. Scripts recorded against uuid test ids (`scene-component:<uuid>`) fitted only the project they were recorded in.

## Decision

- **An index line holds what picking needs:** `- [<name>](<name>.json) — <note> · params … · after <step> · requires <fixture>`, empty fields left out. The until, the steps, the start route, the timeout and the step chain are in the JSON the line links to.
- **The note is the goal:** one sentence of at most 120 characters, what the script does and how it ends. What a parameter stands for goes in `paramNotes` in the JSON, not in the note. Checks outside the app (file content, checksums) belong to the test scenario, not to a script.
- **No uuid in a saved script:** not in the until, the steps, a `--param` value, the note or a param note. Save refuses one. Targets go by visible text or by path. Scripts already saved with a uuid still replay.

## Alternatives

- **Keep the full line, cap its length.** It keeps every field, but a truncated until or step chain is useless, and the size comes from fields that picking never reads.
- **Allow uuids with a warning.** An exact id is the most robust target within one project. But the store is shared across worktrees and machines, and a fixture that writes fixed uuids still ties every script to that one fixture.

## Consequences

- A fixture that writes stable uuids (a demo scene) does not make them usable as targets: a script picks its rows by name.
- The index format replaces the index parts of ADR 0004 and ADR 0005. Their other decisions stand.
