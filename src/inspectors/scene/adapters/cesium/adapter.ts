import { WebGLEngine } from '../../../../types.js'
import type { SceneAdapter, SceneNode } from '../../types.js'
import {
  CESIUM_EXTRACT_SCRIPT,
  cesiumGotoScript,
  cesiumLocateScript,
  type RawCesiumEntity,
  type RawCesiumViewer,
} from './injection.js'

function isRawCesiumEntity(value: unknown): value is RawCesiumEntity {
  const e = value as Record<string, unknown> | null
  return typeof e?.id === 'string' && typeof e.name === 'string' && Array.isArray(e.kinds)
}

function isRawCesiumViewer(value: unknown): value is RawCesiumViewer {
  const v = value as Record<string, unknown> | null
  const isDataSource = (ds: unknown) => {
    const d = ds as Record<string, unknown> | null
    return typeof d?.name === 'string' && Array.isArray(d.entities) && d.entities.every(isRawCesiumEntity)
  }
  return typeof v?.key === 'string'
    && Array.isArray(v.entities) && v.entities.every(isRawCesiumEntity)
    && Array.isArray(v.dataSources) && v.dataSources.every(isDataSource)
}

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
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isRawCesiumViewer)) return null
    const viewers = raw.map(viewerNode)
    return viewers.length === 1 ? viewers[0] : { type: 'Cesium', name: '', visible: true, children: viewers }
  },
  locateScript: cesiumLocateScript,
  gotoScript: cesiumGotoScript,
}
