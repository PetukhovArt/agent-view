// Injected via Runtime.evaluate; serializePixiStage is embedded by .toString()
// so the same TS function runs in the page and is unit-testable on the host.

export type RawPixiNode = {
  type: string
  name: string
  x: number
  y: number
  visible: boolean
  tint: number | null
  alpha: number
  scaleX: number
  scaleY: number
  rotationRad: number
  width: number
  height: number
  children: RawPixiNode[]
}

type PixiDisplayObject = {
  constructor?: { name?: string }
  label?: string
  name?: string
  x?: number
  y?: number
  visible?: boolean
  tint?: number
  alpha?: number
  scale?: { x?: number; y?: number }
  rotation?: number
  width?: number
  height?: number
  children?: PixiDisplayObject[]
}

const HARD_DEPTH_LIMIT = 100

export function serializePixiStage(stage: PixiDisplayObject, depth: number): RawPixiNode | null {
  if (depth > HARD_DEPTH_LIMIT) return null
  const kids = stage.children ?? []
  const children: RawPixiNode[] = []
  for (const kid of kids) {
    const child = serializePixiStage(kid, depth + 1)
    if (child) children.push(child)
  }
  return {
    type: stage.constructor?.name ?? 'Unknown',
    name: stage.label || stage.name || '',
    x: Math.round(stage.x ?? 0),
    y: Math.round(stage.y ?? 0),
    visible: stage.visible !== false,
    tint: typeof stage.tint === 'number' ? stage.tint : null,
    alpha: stage.alpha ?? 1,
    scaleX: stage.scale?.x ?? 1,
    scaleY: stage.scale?.y ?? 1,
    rotationRad: stage.rotation ?? 0,
    width: Math.round(stage.width ?? 0),
    height: Math.round(stage.height ?? 0),
    children,
  }
}

export const PIXI_EXTRACT_SCRIPT = `
(function () {
  var devtools = window.__PIXI_DEVTOOLS__;
  if (!devtools) return null;
  var app = devtools.app || (devtools.stage && devtools.stage.parent);
  var stage = (app && app.stage) || devtools.stage;
  if (!stage) return null;
  var serialize = ${serializePixiStage.toString()};
  return serialize(stage, 0);
})()
`
