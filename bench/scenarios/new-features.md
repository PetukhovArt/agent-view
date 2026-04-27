# Bench scenarios for v0.5.0 features

Run after `cd bench/app && npm start &` (CDP on :19222).

Each scenario states a `What to verify` and the expected outcome.

## 1. dom --compact
What to verify: single-child chains merge onto one line, refs preserved.
- `agent-view dom --compact --filter "Search"` → expects line like `... > section "Search" ... [ref=N]` instead of nested 3-line block
- compare with `agent-view dom --filter "Search"` (non-compact) — line count of compact MUST be ≤ non-compact

## 2. dom --count
What to verify: returns single integer.
- `agent-view dom --count` → single number, no tree
- `agent-view dom --count --filter "Checkbox"` → integer matching count of "Checkbox" matches in --filter output

## 3. dom --max-lines
What to verify: hard truncation with summary tail.
- `agent-view dom --max-lines 5` → exactly 5 lines, last line is `… N more nodes`
- `agent-view dom --max-lines 10000` → no truncation (full tree under 10k lines)

## 4. dom --diff
What to verify: line-level diff against last call.
- `agent-view dom` (warm cache)
- `agent-view dom --diff` → expects "No changes"
- click a checkbox to toggle state, then `agent-view dom --diff` → expects + and/or - lines

## 5. cache-hit annotation
What to verify: `[cache]` prefix on second call within TTL.
- `agent-view dom` → no prefix (first call cold)
- `agent-view dom` immediately again → first line is `[cache]`

## 6. scene --compact
Bench app has no PixiJS — skip on bench, document as "needs PixiJS app like SCADA".

## 7. snap --scale
What to verify: snap output gains a Screenshot section with file path.
- `agent-view snap --scale 0.5` → output contains `=== Screenshot ===` and a path ending in `.webp`

## 8. screenshot --crop
What to verify: crop matches element bounding box, file saved.
- `agent-view screenshot --crop "Search"` → file path returned, file exists and is smaller than full screenshot
- `agent-view screenshot --crop "DefinitelyDoesNotExist"` → warning + full screenshot fallback

## 9. WebP for scaled screenshots
What to verify: extension is `.webp` when --scale < 1.
- `agent-view screenshot --scale 0.5` → path ends with `.webp`
- `agent-view screenshot` (no scale) → `.png`

## 10. console --follow --until
What to verify: stream exits early on pattern match.
- inject log: `agent-view eval "setTimeout(() => console.log('READY-NOW'), 200)"`
- `agent-view console --follow --until "READY-NOW" --timeout 5` → exits within ~1s with the matching line

## 11. console --target fuzzy
What to verify: substring match on title/URL works.
- `agent-view console --target bench` (substring of page URL) → returns messages, no "target not found" error

## 12. verify-recipe skill
Markdown-only — skipped at runtime.
