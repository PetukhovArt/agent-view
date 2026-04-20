# Token Optimization TODO

Goal: minimize Claude context tokens consumed per verification call.

## Shipped

- [x] `screenshot --scale <0..1>` — CDP clip+JPEG, ~3–12× fewer vision tokens
- [x] `rtk agent-view dom` — RTK text compression in skill workflow
- [x] DOM-first workflow in SKILL.md — screenshot only for final visual confirm
- [x] AX tree cache (300ms TTL) — avoids redundant CDP roundtrips
- [x] `queryAXTree` targeted lookup — skips full-tree fetch on plain-string filters
- [x] `dom --text` — textContent fallback when element has no ARIA role in AX tree
- [x] `resolveDepth` — auto unlimited depth when `--filter` set; depth=4 default otherwise

## Planned

### High impact

- [ ] **`dom --compact`** — strip indentation + merge single-child nodes into one line;
  large apps have deep trees with lots of whitespace, compact mode could cut DOM output 40–60%

- [ ] **`screenshot --crop <filter>`** — crop screenshot to bounding box of a matched element;
  e.g. `screenshot --crop "Settings panel" --scale 0.5` captures only the relevant region,
  potentially 1 tile instead of 12

- [ ] **`dom --count`** — return only element count for a filter, no tree output;
  useful for "does this section have N rows?" without reading the full subtree

### Medium impact

- [ ] **Output line budget** — `dom --max-lines <n>` hard-truncates output with a summary line
  ("… 47 more nodes"); prevents accidentally large DOM dumps eating context

- [ ] **`scene --compact`** — same as dom --compact but for scene graph output

- [ ] **WebP format for scaled screenshots** — WebP at q=80 is ~30% smaller than JPEG at same quality;
  file size doesn't affect Claude token count (pixel-based), but reduces disk I/O and server-to-CLI transfer

### Low impact / research

- [ ] **`dom --diff`** — only emit nodes that changed since last call (like `scene --diff`);
  requires snapshotting the formatted output, not just the AX tree

- [ ] **Cache-hit annotation** — prepend `[cache]` to dom output when served from AX cache;
  helps user decide whether to invalidate vs re-use

- [ ] **`snap --scale`** — pass scale through to screenshot in combined snap output
