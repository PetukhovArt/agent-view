import { describe, expect, it } from 'vitest'
import { parseScenePlace, withHeight } from './index.js'

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

describe('withHeight', () => {
  it.each([
    ['Tower 3', '2000', { scene: 'Tower 3', height: 2000 }],
    ['10,20', ' 150.5 ', { lon: 10, lat: 20, height: 150.5 }],
    ['10,20,300', undefined, { lon: 10, lat: 20, height: 300 }],
  ])('%s --height %s', (raw, height, place) => {
    expect(withHeight(parseScenePlace(raw), height)).toEqual(place)
  })

  it('refuses a height given twice', () => {
    expect(withHeight(parseScenePlace('10,20,300'), '2000')).toEqual({ error: 'height given twice: in 10,20,300 and as --height 2000' })
  })

  it('refuses a height that is not metres, such as an unfilled parameter', () => {
    expect(withHeight(parseScenePlace('Tower 3'), '${H}')).toEqual({ error: '--height <metres>: "${H}" is not a number' })
  })
})
