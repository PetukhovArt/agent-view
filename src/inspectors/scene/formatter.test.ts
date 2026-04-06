import { describe, it, expect } from 'vitest'
import { formatNode, diffScenes, hasMatch } from './formatter.js'
import type { SceneNode, SceneOptions } from './types.js'

function makeScene(overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    type: 'Container',
    name: 'root',
    x: 0,
    y: 0,
    visible: true,
    tint: '0xffffff',
    alpha: 1,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    children: [],
    ...overrides,
  }
}

function collect(node: SceneNode, options: SceneOptions = {}): string[] {
  const lines: string[] = []
  formatNode(node, 0, lines, options)
  return lines
}

describe('formatNode', () => {
  it('formats type, name and position', () => {
    const node = makeScene({ type: 'Sprite', name: 'hero', x: 10, y: 20 })
    const lines = collect(node)
    expect(lines[0]).toBe('Sprite "hero" (10,20)')
  })

  it('marks hidden nodes with [hidden]', () => {
    const node = makeScene({ visible: false })
    const lines = collect(node)
    expect(lines[0]).toContain('[hidden]')
  })

  it('shows tint when not white (0xffffff)', () => {
    const node = makeScene({ tint: '0xff0000' })
    const lines = collect(node)
    expect(lines[0]).toContain('tint=0xff0000')
  })

  it('skips tint when white (0xffffff)', () => {
    const node = makeScene({ tint: '0xffffff' })
    const lines = collect(node)
    expect(lines[0]).not.toContain('tint=')
  })

  it('skips tint when white (#ffffff)', () => {
    const node = makeScene({ tint: '#ffffff' })
    const lines = collect(node)
    expect(lines[0]).not.toContain('tint=')
  })

  it('shows verbose props: alpha when not 1', () => {
    const node = makeScene({ alpha: 0.5 })
    const lines = collect(node, { verbose: true })
    expect(lines[0]).toContain('alpha=0.5')
  })

  it('shows verbose props: scale when not (1,1)', () => {
    const node = makeScene({ scaleX: 2, scaleY: 3 })
    const lines = collect(node, { verbose: true })
    expect(lines[0]).toContain('scale=(2,3)')
  })

  it('shows verbose props: rotation when not 0', () => {
    const node = makeScene({ rotation: 45 })
    const lines = collect(node, { verbose: true })
    expect(lines[0]).toContain('rot=45°')
  })

  it('omits verbose props when all defaults', () => {
    const node = makeScene()
    const lines = collect(node, { verbose: true })
    expect(lines[0]).not.toContain('alpha=')
    expect(lines[0]).not.toContain('scale=')
    expect(lines[0]).not.toContain('rot=')
  })

  it('respects depth limit', () => {
    const child = makeScene({ name: 'child', type: 'Sprite' })
    const parent = makeScene({ children: [child] })
    const lines = collect(parent, { depth: 0 })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('root')
  })

  it('includes children within depth limit', () => {
    const child = makeScene({ name: 'child', type: 'Sprite' })
    const parent = makeScene({ children: [child] })
    const lines = collect(parent, { depth: 1 })
    expect(lines).toHaveLength(2)
  })

  it('filters by name — shows matching node', () => {
    const node = makeScene({ name: 'hero' })
    const lines = collect(node, { filter: 'hero' })
    expect(lines).toHaveLength(1)
  })

  it('filters by name — hides non-matching node', () => {
    const node = makeScene({ name: 'enemy' })
    const lines = collect(node, { filter: 'hero' })
    expect(lines).toHaveLength(0)
  })

  it('filters by type', () => {
    const node = makeScene({ type: 'Sprite', name: 'enemy' })
    const lines = collect(node, { filter: 'sprite' })
    expect(lines).toHaveLength(1)
  })

  it('shows parent when child matches filter', () => {
    const child = makeScene({ name: 'hero', type: 'Sprite' })
    const parent = makeScene({ name: 'root', children: [child] })
    const lines = collect(parent, { filter: 'hero' })
    // parent visible because it has matching child
    expect(lines.some(l => l.includes('root'))).toBe(true)
    expect(lines.some(l => l.includes('hero'))).toBe(true)
  })
})

describe('diffScenes', () => {
  it('returns "No changes" when scenes are identical', () => {
    const scene = makeScene()
    expect(diffScenes(scene, scene)).toBe('No changes')
  })

  it('detects position change', () => {
    const prev = makeScene({ x: 0, y: 0 })
    const curr = makeScene({ x: 10, y: 20 })
    const result = diffScenes(prev, curr)
    expect(result).toContain('pos: (0,0)→(10,20)')
  })

  it('detects visibility change', () => {
    const prev = makeScene({ visible: true })
    const curr = makeScene({ visible: false })
    const result = diffScenes(prev, curr)
    expect(result).toContain('visible: true→false')
  })

  it('detects added child', () => {
    const prev = makeScene()
    const child = makeScene({ name: 'newChild', type: 'Sprite' })
    const curr = makeScene({ children: [child] })
    const result = diffScenes(prev, curr)
    expect(result).toContain('+ Sprite "newChild"')
  })

  it('detects removed child', () => {
    const child = makeScene({ name: 'oldChild', type: 'Sprite' })
    const prev = makeScene({ children: [child] })
    const curr = makeScene()
    const result = diffScenes(prev, curr)
    expect(result).toContain('- Sprite "oldChild"')
  })

  it('detects change in existing child', () => {
    const prevChild = makeScene({ name: 'child', type: 'Sprite', x: 0, y: 0 })
    const currChild = makeScene({ name: 'child', type: 'Sprite', x: 5, y: 5 })
    const prev = makeScene({ children: [prevChild] })
    const curr = makeScene({ children: [currChild] })
    const result = diffScenes(prev, curr)
    expect(result).toContain('pos: (0,0)→(5,5)')
  })
})

describe('hasMatch', () => {
  it('matches by name (case-insensitive)', () => {
    const node = makeScene({ name: 'HeroSprite' })
    expect(hasMatch(node, 'hero')).toBe(true)
  })

  it('matches by type (case-insensitive)', () => {
    const node = makeScene({ type: 'Sprite' })
    expect(hasMatch(node, 'sprite')).toBe(true)
  })

  it('finds match recursively in children', () => {
    const child = makeScene({ name: 'targetNode', type: 'Text' })
    const parent = makeScene({ children: [child] })
    expect(hasMatch(parent, 'target')).toBe(true)
  })

  it('returns false when no match', () => {
    const child = makeScene({ name: 'other', type: 'Sprite' })
    const parent = makeScene({ name: 'root', children: [child] })
    expect(hasMatch(parent, 'missing')).toBe(false)
  })
})
