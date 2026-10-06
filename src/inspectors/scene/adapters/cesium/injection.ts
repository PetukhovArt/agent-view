import type { SceneGoto } from '../../types.js'

// Page-side scripts, run with awaitPromise: finding a viewer of plain CesiumJS waits for a frame.

export type RawCesiumEntity = {
  id: string
  /** `entity.name`, else its label text: apps often name an entity only by its label. */
  name: string
  kinds: string[]
  visible: boolean
  lonLat: [number, number, number] | null
  /** Page CSS px; null with no position, off the canvas, or behind the globe. */
  point: { x: number; y: number } | null
}

export type RawCesiumViewer = {
  key: string
  via: 'vue-cesium' | 'hook' | 'cesiumjs'
  entities: RawCesiumEntity[]
  dataSources: { name: string; entities: RawCesiumEntity[] }[]
}

/** How long plain CesiumJS gets to render the frame that reveals its viewer: a hidden page draws none. */
const FRAME_WAIT_MS = 1000
/** Decimal places of a printed lon/lat: about 0.1 m. */
const LON_LAT_DIGITS = 6
const NO_SCENE = JSON.stringify({ error: 'No cesiumjs scene found', reason: 'missing' })

// Defines `findViewers()` and `findOne(q)` for the scripts below. A viewer is
// { key, via, Cesium, scene, entities, dataSources, time }.
const VIEWERS = `
  var KINDS = ['billboard', 'box', 'corridor', 'cylinder', 'ellipse', 'ellipsoid', 'label', 'model', 'path',
    'plane', 'point', 'polygon', 'polyline', 'polylineVolume', 'rectangle', 'tileset', 'wall'];
  var av = window.__agentView = window.__agentView || {};

  function fromViewer(key, via, Cesium, viewer) {
    return { key: key, via: via, Cesium: Cesium, viewer: viewer, scene: viewer.scene, entities: viewer.entities,
      dataSources: viewer.dataSources, time: viewer.clock.currentTime };
  }

  // Plain CesiumJS keeps its Viewer in no global: catch the DataSourceDisplay a frame updates.
  async function catchFrames(Cesium) {
    var proto = Cesium.DataSourceDisplay.prototype;
    var update = proto.update;
    var displays = new Map();
    proto.update = function (time) {
      displays.set(this, time);
      return update.apply(this, arguments);
    };
    try {
      await new Promise(function (done) {
        requestAnimationFrame(function () { requestAnimationFrame(done); });
        setTimeout(done, ${FRAME_WAIT_MS});
      });
    } finally {
      proto.update = update;
    }
    return Array.from(displays, function (entry, i) {
      var display = entry[0];
      return { key: 'viewer-' + i, via: 'cesiumjs', Cesium: Cesium, scene: display.scene,
        entities: display.defaultDataSource.entities, dataSources: display._dataSourceCollection, time: entry[1] };
    });
  }

  // Overlapping calls share one catch: a second patch would wrap the first and restore it, not the original.
  function fromFrames(Cesium) {
    if (!av.cesiumFrames) av.cesiumFrames = catchFrames(Cesium).finally(function () { av.cesiumFrames = undefined; });
    return av.cesiumFrames;
  }

  async function findViewers() {
    var found = [];
    document.querySelectorAll('[data-v-app]').forEach(function (el) {
      var app = el.__vue_app__;
      var registry = app && app.config.globalProperties.$VueCesium;
      Object.entries(registry || {}).forEach(function (entry) {
        var services = entry[1];
        if (services && services.viewer) found.push(fromViewer(entry[0], 'vue-cesium', services.Cesium, services.viewer));
      });
    });
    var hook = window.__CESIUM_VIEWER__;
    if (!found.length && hook && hook.viewer && hook.Cesium) found.push(fromViewer('viewer-0', 'hook', hook.Cesium, hook.viewer));
    if (!found.length && window.Cesium && window.Cesium.DataSourceDisplay) found = await fromFrames(window.Cesium);
    av.cesium = found.map(function (v) { return { key: v.key, via: v.via, viewer: v.viewer, scene: v.scene, Cesium: v.Cesium }; });
    return found;
  }

  function pagePoint(v, pos) {
    var C = v.Cesium, scene = v.scene;
    // worldToWindowCoordinates answers for the far side of the globe too.
    if (!new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, scene.camera.positionWC).isPointVisible(pos)) return null;
    var T = C.SceneTransforms;
    var win = (T.worldToWindowCoordinates || T.wgs84ToWindowCoordinates).call(T, scene, pos);
    if (!win) return null;
    var rect = scene.canvas.getBoundingClientRect();
    if (win.x < 0 || win.y < 0 || win.x > rect.width || win.y > rect.height) return null;
    return { x: Math.round(rect.left + win.x), y: Math.round(rect.top + win.y) };
  }

  function entityRecord(v, e) {
    var C = v.Cesium;
    var label = e.label && e.label.text ? e.label.text.getValue(v.time) : '';
    var pos = e.position ? e.position.getValue(v.time) : undefined;
    var place = pos ? C.Cartographic.fromCartesian(pos) : undefined;
    return {
      id: e.id,
      name: e.name || label || '',
      names: [e.name, label].filter(Boolean),
      kinds: KINDS.filter(function (k) { return e[k]; }),
      visible: e.isShowing,
      lonLat: place ? [+C.Math.toDegrees(place.longitude).toFixed(${LON_LAT_DIGITS}), +C.Math.toDegrees(place.latitude).toFixed(${LON_LAT_DIGITS}), Math.round(place.height)] : null,
      point: pos ? pagePoint(v, pos) : null,
      entity: e,
      viewer: v,
    };
  }

  function dataSourcesOf(v) {
    var list = [];
    for (var i = 0; i < v.dataSources.length; i++) list.push(v.dataSources.get(i));
    return list;
  }

  function allEntities(v) {
    var records = v.entities.values.map(function (e) { return entityRecord(v, e); });
    dataSourcesOf(v).forEach(function (ds) {
      ds.entities.values.forEach(function (e) { records.push(entityRecord(v, e)); });
    });
    return records;
  }

  // The one entity whose id, name or label text is q, or an { error, reason: 'missing' }.
  async function findOne(q) {
    var viewers = await findViewers();
    if (!viewers.length) return ${NO_SCENE};
    var hits = [];
    viewers.forEach(function (v) {
      allEntities(v).forEach(function (r) { if (r.id === q || r.names.indexOf(q) >= 0) hits.push(r); });
    });
    if (!hits.length) return { error: 'No scene object "' + q + '". Run \`agent-view scene\`', reason: 'missing' };
    if (hits.length > 1) {
      var ids = hits.map(function (r) { return r.id; }).join(', ');
      return { error: hits.length + ' scene objects "' + q + '": ' + ids + ' — address one by id; an act step needs an id the app sets or a unique name', reason: 'missing' };
    }
    return hits[0];
  }
`

export const CESIUM_EXTRACT_SCRIPT = `
(async function () {
  ${VIEWERS}
  function raw(r) { return { id: r.id, name: r.name, kinds: r.kinds, visible: r.visible, lonLat: r.lonLat, point: r.point }; }
  var viewers = await findViewers();
  return viewers.map(function (v) {
    return {
      key: v.key,
      via: v.via,
      entities: v.entities.values.map(function (e) { return raw(entityRecord(v, e)); }),
      dataSources: dataSourcesOf(v).map(function (ds) {
        return { name: ds.name || '', entities: ds.entities.values.map(function (e) { return raw(entityRecord(v, e)); }) };
      }),
    };
  });
})()
`

/**
 * Page {x, y} to click the object `query` at, or { error, reason }. Covered: the object is not
 * among the objects drawn at its point, or HTML over the canvas would take the click there.
 */
export const cesiumLocateScript = (query: string): string => `
(async function () {
  ${VIEWERS}
  var q = ${JSON.stringify(query)};
  var hit = await findOne(q);
  if (hit.error) return hit;
  var covered = { error: 'Scene object "' + q + '" is covered or off screen', reason: 'covered' };
  if (!hit.point) return covered;
  var scene = hit.viewer.scene;
  var rect = scene.canvas.getBoundingClientRect();
  var picked = scene.drillPick(new hit.viewer.Cesium.Cartesian2(hit.point.x - rect.left, hit.point.y - rect.top));
  var isDrawnThere = picked.some(function (p) { return p.id === hit.entity; });
  var isCanvasOnTop = document.elementFromPoint(hit.point.x, hit.point.y) === scene.canvas;
  return isDrawnThere && isCanvasOnTop ? hit.point : covered;
})()
`

/** Points the camera straight down over the target; returns { lonLat } where it went, or { error, reason }. */
export const cesiumGotoScript = (target: SceneGoto): string => `
(async function () {
  ${VIEWERS}
  var target = ${JSON.stringify(target)};
  var v, lon, lat;
  if ('scene' in target) {
    var hit = await findOne(target.scene);
    if (hit.error) return hit;
    if (!hit.lonLat) return { error: 'Scene object "' + target.scene + '" has no position', reason: 'missing' };
    v = hit.viewer;
    lon = hit.lonLat[0];
    lat = hit.lonLat[1];
  } else {
    v = (await findViewers())[0];
    if (!v) return ${NO_SCENE};
    lon = target.lon;
    lat = target.lat;
  }
  var C = v.Cesium, camera = v.scene.camera;
  var height = target.height !== undefined ? target.height : camera.positionCartographic.height;
  camera.setView({
    destination: C.Cartesian3.fromDegrees(lon, lat, height),
    orientation: { heading: 0, pitch: -C.Math.PI_OVER_TWO, roll: 0 },
  });
  v.scene.requestRender();
  return { lonLat: [lon, lat, height] };
})()
`
