import { getAdapter } from './registry.js'
import { formatNode, diffScenes } from './formatter.js'
import type { ClickOpts, PageSession, Point, RuntimeSession } from '../../cdp/types.js'
import type { WebGLEngine } from '../../types.js'
import type { SceneOptions, SceneNode, SceneAdapter, SceneGoto, SceneMiss } from './types.js'

const NO_ENGINE = 'No WebGL engine configured. Add "webgl": { "engine": "pixi" | "cesiumjs" } to agent-view.config.json'
const LON_LAT = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(-?\d+(?:\.\d+)?))?$/
const METRES = /^-?\d+(?:\.\d+)?$/
/** Decimal places of the lon/lat a camera move prints: about 10 m. */
const CAMERA_DIGITS = 4

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

function placeAdapter(engine: WebGLEngine | undefined): Required<Pick<SceneAdapter, 'locateScript' | 'gotoScript'>> | SceneMiss {
  if (!engine) return { error: NO_ENGINE, reason: 'missing' }
  const { locateScript, gotoScript } = getAdapter(engine)
  return locateScript && gotoScript ? { locateScript, gotoScript } : { error: `The ${engine} adapter cannot locate scene objects`, reason: 'missing' }
}

const isSceneMiss = (raw: unknown): raw is SceneMiss => {
  const miss = raw as SceneMiss | null
  return typeof miss?.error === 'string' && (miss.reason === 'missing' || miss.reason === 'covered')
}

const isPoint = (raw: unknown): raw is Point =>
  typeof (raw as Point | null)?.x === 'number' && typeof (raw as Point).y === 'number'

const isMoved = (raw: unknown): raw is { lonLat: [number, number, number] } => {
  const lonLat = (raw as { lonLat?: unknown } | null)?.lonLat
  return Array.isArray(lonLat) && lonLat.length === 3 && lonLat.every(n => typeof n === 'number')
}

const unexpected = (raw: unknown): SceneMiss => ({ error: `Unexpected answer from the page: ${JSON.stringify(raw)}`, reason: 'missing' })

/** `lon,lat[,height]` (degrees, metres; spaces ignored) as coordinates, anything else as a scene object. */
export function parseScenePlace(place: string): SceneGoto {
  const m = LON_LAT.exec(place.replace(/\s+/g, ''))
  if (!m) return { scene: place }
  return { lon: Number(m[1]), lat: Number(m[2]), ...(m[3] === undefined ? {} : { height: Number(m[3]) }) }
}

/** `place` with the camera at `--height` metres; a string, as a saved act step holds it (maybe a filled `${NAME}`). */
export function withHeight(place: SceneGoto, height: string | undefined): SceneGoto | { error: string } {
  if (height === undefined) return place
  if (!METRES.test(height.trim())) return { error: `--height <metres>: "${height}" is not a number` }
  if (place.height !== undefined) return { error: `height given twice: in ${describePlace(place)} and as --height ${height}` }
  return { ...place, height: Number(height) }
}

export const describePlace = (place: SceneGoto): string =>
  ('scene' in place ? place.scene : [place.lon, place.lat, place.height].filter(n => n !== undefined).join(','))

/** Clicks the scene object whose id, name or label is `query` at its page point now, if it takes a click there. */
export async function clickSceneObject(
  conn: PageSession,
  engine: WebGLEngine | undefined,
  query: string,
  opts?: ClickOpts,
): Promise<Point | SceneMiss> {
  const adapter = placeAdapter(engine)
  if ('error' in adapter) return adapter
  const found = await conn.evaluate(adapter.locateScript(query), { awaitPromise: true })
  if (isSceneMiss(found)) return found
  if (!isPoint(found)) return unexpected(found)
  await conn.clickAtPosition(found.x, found.y, opts)
  return found
}

/** Points the camera straight down over `place`. */
export async function moveSceneCamera(
  conn: RuntimeSession,
  engine: WebGLEngine | undefined,
  place: SceneGoto,
): Promise<{ text: string } | SceneMiss> {
  const adapter = placeAdapter(engine)
  if ('error' in adapter) return adapter
  const moved = await conn.evaluate(adapter.gotoScript(place), { awaitPromise: true })
  if (isSceneMiss(moved)) return moved
  if (!isMoved(moved)) return unexpected(moved)
  const [lon, lat, height] = moved.lonLat
  const over = 'scene' in place ? ` "${place.scene}"` : ''
  return { text: `Camera over${over} (${lon.toFixed(CAMERA_DIGITS)}, ${lat.toFixed(CAMERA_DIGITS)}) at ${Math.round(height)} m` }
}

export { diffScenes } from './formatter.js'
export type { SceneNode, SceneOptions, SceneAdapter, SceneGoto, SceneMiss } from './types.js'
