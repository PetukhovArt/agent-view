import { describe, expect, it } from 'vitest'
import { edgePoint } from './act-script.js'

describe('edgePoint', () => {
  it('drops inside the right edge strip, not the replace-zone centre', () => {
    expect(edgePoint({ x: 56, y: 30, width: 1496, height: 850 }, 'right')).toEqual({ x: 1532, y: 455 })
  })

  it('shrinks the inset on a box narrower than 80 px', () => {
    expect(edgePoint({ x: 0, y: 0, width: 20, height: 100 }, 'left')).toEqual({ x: 5, y: 50 })
  })
})
