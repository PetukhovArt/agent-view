# 0009. Any engine through the app's Scene Hook

- Status: Accepted
- Date: 2026-10-16

## Context

`scene`, `click --scene` and the act `scene=` / `goto` steps work through a Scene Adapter per engine (PixiJS, CesiumJS), which reads the engine's internals from the page. Each new engine (MapLibre, three.js, a 2D canvas) would need its own adapter, and WebGL itself holds no objects, only draw calls: what a Scene Object is, and where it is drawn, only the app knows. A map app moving from CesiumJS to another engine would lose its saved scene steps until agent-view caught up.

## Decision

- **Scene Hook:** the app sets `window.__AGENT_VIEW_SCENE__` with `nodes()`, `locate(query)` and `goto(target)`, shaped as agent-view's `SceneNode`, `SceneMiss` and `SceneGoto`. The `app-hook` Scene Adapter only calls it. The contract is documented (`commands.md`, Scene), not exported as a package type: the app copies it, so agent-view's internal types do not become a public API.
- **Chosen by config:** `"webgl": { "engine": "app-hook" }`. A hook present on the page does not switch the engine by itself, so a script behaves the same on a build with the hook and one without. `init` does not detect it.
- **New engines go through the hook.** The PixiJS and CesiumJS adapters stay, because they need no code in the app; no adapter is added for another library.
- **No hook on the page is `missing`,** as a CesiumJS page with no viewer yet: a step waits for it while the page loads.
- **The uuid rule of [ADR 0006](./0006-store-index-is-for-picking-scripts-hold-no-uuid.md) holds for hook ids too.** An id the app sets is stable on one machine, but a uuid from its backend differs on another stand, and the script store is shared. A step addresses such an object by its name or label, or by an id that is no uuid.

## Alternatives

- **An adapter per library:** needs no app code, but agent-view grows with every engine, and an app whose objects are not engine objects (a layer feature, an instanced mesh) still cannot be addressed.
- **The hook wins whenever present:** no config change, but the same script would act on the hook in a dev build and on the engine adapter, or nothing, in another.
- **Let the hook mark its ids stable, or skip the uuid check for `app-hook`:** an exact id is the sharpest target within one database, but it ties the script to that database, as ADR 0006 rejected.

## Consequences

- agent-view knows no app: what an object is, how it is named and how a click reaches it are the hook's.
- The `app-hook` adapter has no bench smoke; it is checked against apps that implement the hook.
