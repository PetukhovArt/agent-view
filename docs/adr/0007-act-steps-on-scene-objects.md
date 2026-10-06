# 0007. Act steps on scene objects

- Status: Accepted
- Date: 2026-10-06

## Context

The step protocol of [ADR 0003](./0003-act-step-protocol-and-replay.md) acts on DOM nodes: a row, or any element with `@x,y`. On a WebGL map the thing to click is a Scene Object, with no DOM node. A step recorded as `css=canvas@x,y` replays at the same pixel, and after a pan, a zoom, a resize or a different start view that pixel holds something else, so the step clicks the wrong object without failing.

## Decision

- **`scene=<object>` target:** a click step on a Scene Object, saved by its id, name or label text. Replay asks the engine's Scene Adapter for the object's page point at step time, then clicks there. The point is never saved.
- **Verdicts:** the adapter tells why it found no point. When no single object answers (none, several, or no scene at all), the step is STALE: the script no longer fits the app. When the object is found but is not drawn at its point, is off screen, or has HTML over the canvas there, the step is FAIL: the app did not show what the script expects. Both are polled for the step's time first, while a scene is still loading.
- **`goto` step:** the camera move (`scene --goto`) is a recorded step, saved as the parsed place (`{ lon, lat, height? }` or `{ scene }`), with `--height` kept as typed (`height: "2000"`) so `--param` can mark it. The clicks after it were chosen on that view, so replay sets the same view first.
- Uuid ids that Cesium generates per load are refused at save, as in [ADR 0006](./0006-store-index-is-for-picking-scripts-hold-no-uuid.md): such a step needs an id the app sets, or a unique name or label.

## Alternatives

- **Canvas pixel (`css=canvas@x,y`):** needs no engine knowledge, but it holds only for the exact view and window size it was recorded in, and it gives no STALE or FAIL when the object moves.
- **Leave the camera out of the script:** smaller scripts, but a replay would then depend on wherever the last user left the map.
