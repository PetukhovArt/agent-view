# Memory leak debugging with `heap`

Read this when the question is "does this action leak?", "why does memory grow?", or a screen gets
slower every time it is opened. The tool is `agent-view heap`; flags are in
[`commands.md`](commands.md#memory-heap).

## The method: three snapshots, one repeated action

A single snapshot proves nothing: every app holds caches, pools and lazily built state that is
alive by design. A leak is what **grows with repetition and does not come back**. So:

1. **Baseline.** Put the app in the state you will return to (the list closed, the dialog
   dismissed). `agent-view heap take --name baseline`.
2. **Repeat the action ~10 times.** Open the dialog and close it, navigate away and back, run the
   search and clear it. Ten repetitions turn a per-action leak into a clear `+10 × N` in the diff
   and drown out one-off allocations. Drive it with `click` / `fill` / `eval`, and finish in the
   baseline state.
3. **Target.** `agent-view heap take --name target`, then `agent-view heap diff baseline target`.
4. **Final (optional).** Do whatever should release the memory (close the view, log out), take
   `final`, and `heap diff target final`. Growth that goes away here is a cache, not a leak.

Every `take` runs a full GC first, so the numbers are live objects only.

## Reading the diff

```
baseline → target (page:Orders): +3,201 nodes, +2.4 MB, detached +240 (+960 KB)
class                          Δcount     Δsize   count
Detached <div class="row">       +240  +960 KB     252
OrderRowVM                        +10   +12 KB      10
(closure)                         +40   +8 KB    9,120
```

- **The header line is the verdict.** `detached +240` after ten repetitions means 24 DOM nodes
  per action are removed from the document but still referenced. `+0 nodes` and `+0 B` means
  nothing leaked; stop.
- **Rows are classes sorted by size growth.** Look for a `Δcount` that is a multiple of your
  repetition count: `+10`, `+20`, `+240` against 10 repetitions is the leak, `+3` is noise.
- **`Detached <tag …>`** rows are DOM nodes out of the document, named as V8 names them
  (`<div class="row">`, `<canvas>`), so the class attribute usually names the component.
  `--detached` shows only these.
- **A named class** (`OrderRowVM`, `Subscription`) growing in step with a detached DOM row is the
  object that owns the node, and the better lead: it is your code.
- **`(closure)`, `(string)`, `(array)`** growing alone are usually the *content* of the leak, not
  its cause; find the named class that grew with them.

`--filter <text>` narrows to a class name substring. Class names print as-is, so quote them:
`--filter "Detached <div"`.

## Finding what holds it

```bash
agent-view heap retainers "Detached <div class=\"row\">" --name target
```

```
Detached <div class="row"> ×252 in "target", retained by:
retainer                     instances
Array []                           240
RowRegistry .el                     12
```

One row per `<retainer class> <edge>`: which object holds the instances and through which property
or index. Read it as *"240 of them sit in an `Array`, 12 are the `.el` field of a `RowRegistry`"*.
The retainer that holds the same multiple as your repetition count is the one to fix; the next
question is who holds *that*: `heap retainers Array` is rarely useful (too many arrays), so go
back to the diff and pick the named class that grew alongside, or read the source for where a
`RowRegistry` keeps `.el`.

Only one hop is computed, and only strong edges: `WeakMap`, `WeakRef` and weak listeners never
appear, so if a retainer is missing, the object is held through something the GC ignores and is
not the leak. Instances holding each other (sibling links) are not listed.

## Common causes, by what the diff shows

| Diff shows                                               | Usual cause                                                                  |
|----------------------------------------------------------|------------------------------------------------------------------------------|
| `Detached <…>` growing, retainer `Array []` / `Map`      | A list of elements or rows kept for lookup and never pruned on unmount       |
| `Detached <…>` growing, retainer `system / Context .<var>` | A closure (listener, observer, timer) captured the node in variable `<var>`, and was never removed |
| A named class growing, no detached DOM                   | A subscription / store watcher registered per mount, unregistered never      |
| `(string)` growing alone, MBs at a time                  | A log buffer or a cache keyed by something unbounded (URL with a timestamp)  |
| Everything grows a little, no multiples                  | Not a leak; warm caches and JIT. Compare `target → final` to confirm         |

## Scope and cost

- `take` is fast (a quarter second on the 30k-node bench app, linear in heap size) and holds the
  parsed graph in the server, never in your context. The snapshot is parsed from one string, so a
  heap above roughly 500 MB is out of reach; that is a DevTools job. Snapshots vanish when the
  server idles out (5 min) or on `heap clear`; take all three in one sitting.
- `--target <worker>` snapshots a worker's own heap; a worker leak is invisible in the page's.
- Retained size, dominators, full retaining paths, duplicate-string scans and the other DevTools
  filters (objects retained by event handlers, by console, by execution context) are not computed.
  When the one hop and the detached filter are not enough, open the app's DevTools Memory panel on
  the same CDP port: the class names printed here are the same ones it shows.
