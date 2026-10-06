import { WebGLEngine } from '../../../../types.js'
import type { SceneAdapter, SceneNode } from '../../types.js'
import {
  CESIUM_EXTRACT_SCRIPT,
  cesiumGotoScript,
  cesiumLocateScript,
  type RawCesiumEntity,
  type RawCesiumViewer,
} from './injection.js'

function entityNode(raw: RawCesiumEntity): SceneNode {
  return {
    type: raw.kinds.join('+') || 'entity',
    name: raw.name,
    x: raw.point?.x,
    y: raw.point?.y,
    visible: raw.visible,
    extras: { id: raw.id },
    verboseExtras: raw.lonLat ? { lonlat: raw.lonLat.join(',') } : undefined,
  }
}

function viewerNode(raw: RawCesiumViewer): SceneNode {
  const entities: SceneNode = { type: 'Entities', name: '', visible: true, children: raw.entities.map(entityNode) }
  const dataSources = raw.dataSources.map((ds): SceneNode =>
    ({ type: 'DataSource', name: ds.name, visible: true, children: ds.entities.map(entityNode) }))
  return { type: 'Viewer', name: raw.key, visible: true, extras: { via: raw.via }, children: [entities, ...dataSources] }
}

export const cesiumAdapter: SceneAdapter = {
  engine: WebGLEngine.CesiumJS,
  extractScript: CESIUM_EXTRACT_SCRIPT,
  normalize(raw: unknown): SceneNode | null {
    if (!Array.isArray(raw) || raw.length === 0) return null
    const viewers = (raw as RawCesiumViewer[]).map(viewerNode)
    return viewers.length === 1 ? viewers[0] : { type: 'Cesium', name: '', visible: true, children: viewers }
  },
  locateScript: cesiumLocateScript,
  gotoScript: cesiumGotoScript,
}
