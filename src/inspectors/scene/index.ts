import { getAdapter } from './registry.js'
import { formatNode, diffScenes } from './formatter.js'
import type { Point, RuntimeSession } from '../../cdp/types.js'
import type { WebGLEngine } from '../../types.js'
import type { SceneOptions, SceneNode, SceneAdapter, SceneGoto } from './types.js'

const NO_ENGINE = 'No WebGL engine configured. Add "webgl": { "engine": "pixi" | "cesiumjs" } to agent-view.config.json'
const LON_LAT = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(-?\d+(?:\.\d+)?))?$/

export async function getSceneGraph(
  conn: RuntimeSession,
  engine: WebGLEngine | undefined,
  options: SceneOptions = {},
): Promise<string> {
  if (!engine) {
    return NO_ENGINE
  }
  const tree = await extract(conn, engine)
  if (!tree) {
    return `No ${engine} scene found`
  }
  const lines: string[] = []
  formatNode(tree, 0, lines, options)
  if (lines.length === 0 && options.filter) {
    return `No scene objects matching "${options.filter}"`
  }
  return lines.join('\n')
}

export async function getRawScene(
  conn: RuntimeSession,
  engine: WebGLEngine | undefined,
): Promise<SceneNode | null> {
  if (!engine) return null
  return extract(conn, engine)
}

async function extract(conn: RuntimeSession, engine: WebGLEngine): Promise<SceneNode | null> {
  const adapter = getAdapter(engine)
  const raw = await conn.evaluate(adapter.extractScript, { awaitPromise: true })
  return adapter.normalize(raw)
}

/** The adapter of an engine that maps scene objects to places (Cesium), or why there is none. */
function mapAdapter(engine: WebGLEngine | undefined): Required<Pick<SceneAdapter, 'locateScript' | 'gotoScript'>> | { error: string } {
  if (!engine) return { error: NO_ENGINE }
  const { locateScript, gotoScript } = getAdapter(engine)
  return locateScript && gotoScript ? { locateScript, gotoScript } : { error: `Scene objects by name need the cesiumjs engine, not ${engine}` }
}

/** Page point of the scene object whose id or name is `query`: on screen and not covered there. */
export async function locateSceneObject(
  conn: RuntimeSession,
  engine: WebGLEngine | undefined,
  query: string,
): Promise<Point | { error: string }> {
  const adapter = mapAdapter(engine)
  if ('error' in adapter) return adapter
  return await conn.evaluate(adapter.locateScript(query), { awaitPromise: true }) as Point | { error: string }
}

/** Points the camera down over `lon,lat[,height]` (degrees, metres) or the scene object `place` names. */
export async function moveSceneCamera(
  conn: RuntimeSession,
  engine: WebGLEngine | undefined,
  place: string,
): Promise<{ text: string } | { error: string }> {
  const adapter = mapAdapter(engine)
  if ('error' in adapter) return adapter
  const m = LON_LAT.exec(place.replace(/\s+/g, ''))
  const target: SceneGoto = m ? { lon: Number(m[1]), lat: Number(m[2]), height: m[3] === undefined ? undefined : Number(m[3]) } : { query: place }
  const moved = await conn.evaluate(adapter.gotoScript(target), { awaitPromise: true }) as { lonLat: number[] } | { error: string }
  if ('error' in moved) return moved
  const [lon, lat, height] = moved.lonLat
  const over = m ? '' : ` "${place}"`
  return { text: `Camera over${over} (${lon.toFixed(4)}, ${lat.toFixed(4)}) at ${Math.round(height)} m` }
}

export { diffScenes } from './formatter.js'
export type { SceneNode, SceneOptions, SceneAdapter } from './types.js'
