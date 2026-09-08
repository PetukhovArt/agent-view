# Design conformance

Comparing captured screenshots against design references. Triggered when you are handed
`(label, screenshot command, expected reference path)` rows — from a plan, or from the developer
directly. Execute them yourself, inline, no subagent.

For each row:

1. Run the screenshot command; capture the saved file path from stdout.
2. Open both images for visual comparison — the capture and the `expected_path`. (Any harness
   capability that loads an image into context; in Claude Code that is the file-read tool.) If
   `expected_path` does not exist or cannot be read, mark the pair `skipped (expected_missing)`
   and move on.
3. Compare for: layout (relative position, alignment), sizing, color (dominant color family),
   typography (weight/size broadly), content presence (anything missing or extra), decorations
   (borders, shadows, dashed/solid lines, icons).
4. Report each pair as `match` / `minor_mismatch` / `major_mismatch` with a one-sentence deviation.
   - **Major** — missing or wrong component, broken layout, wrong color family, wrong text content.
   - **Minor** — <10px spacing drift, slight color shade, small decoration difference.

Tolerance default is a designer's code-review level: flag what they would notice, ignore
anti-aliasing noise. Do not speculate about CSS causes — describe what looks different and let the
developer decide.
