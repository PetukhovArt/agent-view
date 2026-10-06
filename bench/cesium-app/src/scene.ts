// Scene shared by index.html (vue-cesium) and plain.html (plain CesiumJS).

export interface Point {
  lng: number
  lat: number
}

export interface Camera extends Point {
  id?: string
  name: string
}

const CENTER: Point = { lng: 37.62, lat: 55.75 }

export const START_VIEW = { ...CENTER, height: 5000 }

export const CAMERAS: Camera[] = [
  { name: 'Канал 1', lng: CENTER.lng - 0.01, lat: CENTER.lat + 0.004 },
  { name: 'Канал 2', lng: CENTER.lng + 0.01, lat: CENTER.lat + 0.004 },
  { name: 'Канал 3', lng: CENTER.lng, lat: CENTER.lat - 0.006 },
  { id: 'cam-4', name: 'Канал 4', lng: CENTER.lng + 0.02, lat: CENTER.lat - 0.008 },
  { name: 'За глобусом', lng: CENTER.lng - 180, lat: -CENTER.lat },
]

export const SECTOR: Point[] = [
  { lng: CENTER.lng - 0.02, lat: CENTER.lat - 0.012 },
  { lng: CENTER.lng - 0.012, lat: CENTER.lat - 0.004 },
  { lng: CENTER.lng - 0.024, lat: CENTER.lat - 0.002 },
]

export const CLUSTER: Camera = { id: 'cl-2', name: 'cl-2', lng: CENTER.lng - 0.02, lat: CENTER.lat + 0.012 }

export const LABEL_OFFSET = { x: 0, y: -28 }

const ICON_SIZE = 24

const drawIcon = (): string => {
  const canvas = document.createElement('canvas')
  canvas.width = ICON_SIZE
  canvas.height = ICON_SIZE
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#e53935'
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 3
  ctx.beginPath()
  ctx.arc(ICON_SIZE / 2, ICON_SIZE / 2, ICON_SIZE / 2 - 2, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  return canvas.toDataURL()
}

export const ICON = drawIcon()

interface Hit {
  button: 'left' | 'right'
  id: string | null
  name: string | null
}

declare global {
  interface Window {
    __hits: Hit[]
  }
}

// Entities here carry no `name` (as in web-client), so the label text stands in for it.
export const recordClicks = (Cesium: any, viewer: any): void => {
  window.__hits = []
  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas)
  const record = (button: Hit['button']) => (event: { position: unknown }) => {
    const entity = viewer.scene.pick(event.position)?.id
    const label = entity?.label?.text?.getValue(viewer.clock.currentTime)
    window.__hits.push({ button, id: entity?.id ?? null, name: entity?.name ?? label ?? null })
  }
  handler.setInputAction(record('left'), Cesium.ScreenSpaceEventType.LEFT_CLICK)
  handler.setInputAction(record('right'), Cesium.ScreenSpaceEventType.RIGHT_CLICK)
}
