# Scenario mode (from a plan)

When UI scenarios are pre-generated (e.g. a plan file with a `## UI Scenarios` section): read the steps, resolve each
symbolic `$var` via `agent-view dom --filter "<text>" --depth 3` to a ref, execute the steps in order, and verify each
expected outcome with `dom --filter`. Screenshot only on `fail` and at the end of an E2E scenario, never per step.

Heuristics for plan runs, on top of the ones in `SKILL.md`:

1. **Invariants run first or fail closed.** When the plan states invariants, execute those steps before the
   action-specific checks. A failed invariant is `fail` for that invariant *and* a flag on the rest of the run — keep
   running the remaining steps, tagged "trust-impaired until invariant restored". Call invariant violations out
   separately in the report.

2. **UI-vs-model mismatch is the bug, not noise.** When a count or hierarchy check returns
   `match: false`, the default hypothesis is that the UI renderer is wrong. Before reaching for "the filter matched
   something extra in a side panel", query the bounding boxes and ancestor chains of the matched elements — two matches
   at the same x in adjacent y rows are sibling rows in one list, i.e. a renderer bug. The model is one representation,
   not the source of truth; the bug may live in the gap between model and UI.

3. **Defensive eval reads.** Sentinel-check every `node.field` read (`transform.x`,
   `transform.width`) before using it in arithmetic. A renamed field silently returns `NaN`/`null`, which fail-passes
   downstream comparisons. Add `isFinite(value)` / `value !== undefined` guards inline.

4. **No hardcoded literal IDs.** A hardcoded node-ID prefix that no longer matches the current scene degrades the whole
   check to a silent no-op. Verify at least one expected ID exists; if not, derive IDs by role at runtime, proceed with
   the corrected lookup, and say the plan needs an ID refresh.

5. **Reload checkpoint is not optional.** If the feature mutated persisted structure, run one:
   `agent-view eval "location.reload()"`, wait for the app to come back, re-read the structural signature, diff. Drift
   is a real bug, not a "fixed-up on save".

After two or three consecutive failures, stop and distinguish "the plan is stale" (hardcoded IDs no longer match the
UI) from "the feature is broken" (invariants violated on a current scene) — they need opposite fixes.
