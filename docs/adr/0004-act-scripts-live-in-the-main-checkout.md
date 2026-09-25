# 0004. Act scripts live in the main checkout of the project

- Status: Accepted
- Date: 2026-09-25

## Context

`act save` wrote every recording to one global `~/.agent-view/scratch/`. Scripts of different apps mixed with throwaway ones, nothing said which project a script belonged to or where it started, and agents did not look there: on web-client each verifier re-explored the same paths (admin → rights, settings → connections, licenses → keys) at Opus cost instead of a 1–2 s replay ([ADR 0003](./0003-act-step-protocol-and-replay.md)).

A script belongs to the app it drives, and one app is usually checked out many times: the owner of web-client runs a dozen git worktrees, and verifiers often work inside one of them.

## Decision

The **Script Store** is `<main checkout>/<config dir relative to the repo root>/.agent-view/scripts/`. The server resolves it per request from the CLI's `cwd` with `git rev-parse --git-common-dir --show-toplevel`; outside git it is the config directory itself. Every worktree of a project reads and writes the same store.

Scripts carry what an agent needs to pick one without replaying it: a `note`, the `start` route (hash or path, never origin or absolute file path) and an `after` prerequisite. Every save regenerates `INDEX.md` in the store; `act list` prints the same lines.

`~/.agent-view/scratch/` stays readable as a fallback for older recordings; nothing writes there any more.

## Alternatives

- **`~/.agent-view/projects/<slug>/`, slug from the path** (Claude Code's memory layout). Per-machine and per-user; each worktree path is its own slug unless keyed by the git common dir, and the scripts can never be shared through the repo.
- **Store inside each checkout.** The natural reading of "in the repo", but a path recorded in the main checkout is invisible from a worktree until committed, and the same path gets re-recorded once per worktree.

## Consequences

- A worktree run can write into the main checkout's working tree. The store is expected to be gitignored (`.agent-view/` already is in web-client), so this touches no branch.
- Committing the store later is a one-line `.gitignore` change. Once committed, a branch's scripts still resolve from the main checkout, not the worktree's branch; a UI change on a branch that breaks a script shows up as STALE and is re-recorded.
- Recorded values other than passwords (a login name) are stored as typed. Before the store is committed they need replacing by an env reference.
