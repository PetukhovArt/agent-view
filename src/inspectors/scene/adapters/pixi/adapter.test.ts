import { describe, it, expect } from 'vitest'
import { pixiAdapter } from './adapter.js'
import { serializePixiStage, type RawPixiNode } from './injection.js'

function makeRaw(overrides: Partial<RawPixiNode> = {}): RawPixiNode {
  return {
    type: 'Container',
    name: 'root',
    x: 0,
    y: 0,
    visible: true,
    tint: null,
    alpha: 1,
    scaleX: 1,
    scaleY: 1,
    rotationRad: 0,
    width: 0,
    height: 0,
    children: [],
    ...overrides,
  }
}

describe('pixiAdapter.normalize', () => {
  it('returns null for non-objects', () => {
    expect(pixiAdapter.normalize(null)).toBeNull()
    expect(pixiAdapter.normalize(undefined)).toBeNull()
    expect(pixiAdapter.normalize(42)).toBeNull()
  })

  it('returns null for shape mismatch', () => {
    expect(pixiAdapter.normalize({ foo: 'bar' })).toBeNull()
  })

  it('maps core fields straight through', () => {
    const node = pixiAdapter.normalize(makeRaw({ type: 'Sprite', name: 'hero', x: 5, y: 7, visible: false }))
    expect(node).toMatchObject({ type: 'Sprite', name: 'hero', x: 5, y: 7, visible: false })
  })

  it('emits tint as inline extra (hex), skipping pure white', () => {
    expect(pixiAdapter.normalize(makeRaw({ tint: 0xffffff }))?.extras).toBeUndefined()
    expect(pixiAdapter.normalize(makeRaw({ tint: 0xff0000 }))?.extras).toEqual({ tint: '#ff0000' })
    expect(pixiAdapter.normalize(makeRaw({ tint: null }))?.extras).toBeUndefined()
  })

  it('pads short hex tints', () => {
    expect(pixiAdapter.normalize(makeRaw({ tint: 0x00ff00 }))?.extras).toEqual({ tint: '#00ff00' })
  })

  it('emits verbose extras only when fields are non-default', () => {
    expect(pixiAdapter.normalize(makeRaw())?.verboseExtras).toBeUndefined()
    const node = pixiAdapter.normalize(makeRaw({ alpha: 0.5, scaleX: 2, scaleY: 3, rotationRad: Math.PI / 2, width: 10, height: 20 }))
    expect(node?.verboseExtras).toEqual({
      alpha: '0.5',
      scale: '(2,3)',
      rot: '90°',
      size: '10x20',
    })
  })

  it('recurses into children', () => {
    const raw = makeRaw({ children: [makeRaw({ name: 'kid', type: 'Sprite' })] })
    const node = pixiAdapter.normalize(raw)
    expect(node?.children?.[0]).toMatchObject({ name: 'kid', type: 'Sprite' })
  })

  it('omits children prop when empty', () => {
    expect(pixiAdapter.normalize(makeRaw())?.children).toBeUndefined()
  })
})

describe('serializePixiStage (injected serializer)', () => {
  it('extracts type from constructor.name', () => {
    const stage = { constructor: { name: 'Sprite' }, label: 'hero', x: 5, y: 6 }
    const raw = serializePixiStage(stage, 0)
    expect(raw).toMatchObject({ type: 'Sprite', name: 'hero', x: 5, y: 6 })
  })

  it('prefers label over name', () => {
    const stage = { label: 'L', name: 'N' }
    expect(serializePixiStage(stage, 0)?.name).toBe('L')
  })

  it('falls back to name when label missing', () => {
    expect(serializePixiStage({ name: 'N' }, 0)?.name).toBe('N')
  })

  it('returns null past depth limit', () => {
    expect(serializePixiStage({}, 101)).toBeNull()
  })

  it('walks children', () => {
    const stage = { constructor: { name: 'Container' }, children: [{ constructor: { name: 'Sprite' }, name: 'kid' }] }
    const raw = serializePixiStage(stage, 0)
    expect(raw?.children).toHaveLength(1)
    expect(raw?.children[0]).toMatchObject({ type: 'Sprite', name: 'kid' })
  })
})
