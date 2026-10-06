import { CAMERAS, CLUSTER, ICON, LABEL_OFFSET, SECTOR, START_VIEW, recordClicks } from './scene'

const Cesium = (window as unknown as { Cesium: any }).Cesium

const viewer = new Cesium.Viewer('viewer', {
  baseLayer: Cesium.ImageryLayer.fromProviderAsync(
    Cesium.TileMapServiceImageryProvider.fromUrl(Cesium.buildModuleUrl('Assets/Textures/NaturalEarthII')),
  ),
  baseLayerPicker: false,
  geocoder: false,
  animation: false,
  timeline: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  fullscreenButton: false,
})

viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(START_VIEW.lng, START_VIEW.lat, START_VIEW.height),
  orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
})

const pixelOffset = new Cesium.Cartesian2(LABEL_OFFSET.x, LABEL_OFFSET.y)

for (const cam of CAMERAS) {
  viewer.entities.add({
    id: cam.id,
    position: Cesium.Cartesian3.fromDegrees(cam.lng, cam.lat),
    billboard: { image: ICON },
    label: { text: cam.name, pixelOffset, font: '14px sans-serif' },
  })
}

viewer.entities.add({
  polygon: {
    hierarchy: Cesium.Cartesian3.fromDegreesArray(SECTOR.flatMap((p) => [p.lng, p.lat])),
    material: Cesium.Color.fromCssColorString('rgba(255,193,7,0.4)'),
  },
})

const clusters = new Cesium.CustomDataSource('clusters')
clusters.entities.add({
  id: CLUSTER.id,
  position: Cesium.Cartesian3.fromDegrees(CLUSTER.lng, CLUSTER.lat),
  billboard: { image: ICON },
})
viewer.dataSources.add(clusters)

recordClicks(Cesium, viewer)
