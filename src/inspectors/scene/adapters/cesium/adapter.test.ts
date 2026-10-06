import { describe, expect, it } from 'vitest'
import { cesiumAdapter } from './adapter.js'
import type { RawCesiumViewer } from './injection.js'

const viewer: RawCesiumViewer = {
  key: 'viewer-0',
  via: 'hook',
  entities: [
    { id: 't3', name: 'Tower 3', kinds: ['billboard', 'label'], visible: true, lonLat: [10, 20, 0], point: { x: 640, y: 410 } },
    { id: 'z1', name: '', kinds: ['polygon'], visible: true, lonLat: null, point: null },
  ],
  dataSources: [{ name: '', entities: [] }],
}

describe('cesiumAdapter.normalize', () => {
  it('turns a viewer into Viewer > Entities / DataSource nodes, an entity keyed by id', () => {
    expect(cesiumAdapter.normalize([viewer])).toEqual({
      type: 'Viewer', name: 'viewer-0', visible: true, extras: { via: 'hook' }, children: [
        { type: 'Entities', name: '', visible: true, children: [
          { type: 'billboard+label', name: 'Tower 3', x: 640, y: 410, visible: true, extras: { id: 't3' }, verboseExtras: { lonlat: '10,20,0' } },
          { type: 'polygon', name: '', x: undefined, y: undefined, visible: true, extras: { id: 'z1' }, verboseExtras: undefined },
        ] },
        { type: 'DataSource', name: '', visible: true, children: [] },
      ],
    })
  })

  it('refuses a page answer of another shape', () => {
    expect(cesiumAdapter.normalize([{ key: 'viewer-0', entities: 'none' }])).toBeNull()
  })
})
