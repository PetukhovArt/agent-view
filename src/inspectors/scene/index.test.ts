import { describe, expect, it } from 'vitest'
import { parseScenePlace } from './index.js'

describe('parseScenePlace', () => {
  it.each([
    ['10.5,45.25', { lon: 10.5, lat: 45.25 }],
    ['-142.38, -55.75', { lon: -142.38, lat: -55.75 }],
    ['10,20,-30.5', { lon: 10, lat: 20, height: -30.5 }],
    ['Tower 3', { scene: 'Tower 3' }],
    ['12,north', { scene: '12,north' }],
  ])('%s', (raw, place) => {
    expect(parseScenePlace(raw)).toEqual(place)
  })
})
