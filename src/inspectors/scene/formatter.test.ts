import { describe, it, expect } from 'vitest'
import { formatNode, diffScenes } from './formatter.js'
import type { SceneNode, SceneOptions } from './types.js'

function makeScene(overrides: Partial<SceneNode> = {}): SceneNode {
  return {
    type: 'Container',
    name: 'root',
    x: 0,
    y: 0,
    visible: true,
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

  it('shows inline extras (e.g. tint)', () => {
    const node = makeScene({ extras: { tint: '#ff0000' } })
    const lines = collect(node)
    expect(lines[0]).toContain('tint=#ff0000')
  })

  it('omits inline extras when not provided', () => {
    const node = makeScene()
    const lines = collect(node)
    expect(lines[0]).not.toContain('tint=')
  })

  it('shows verbose extras only when --verbose', () => {
    const node = makeScene({ verboseExtras: { alpha: '0.5' } })
    expect(collect(node)[0]).not.toContain('alpha=')
    expect(collect(node, { verbose: true })[0]).toContain('alpha=0.5')
  })

  it('shows verbose extras: scale', () => {
    const node = makeScene({ verboseExtras: { scale: '(2,3)' } })
    const lines = collect(node, { verbose: true })
    expect(lines[0]).toContain('scale=(2,3)')
  })

  it('shows verbose extras: rotation', () => {
    const node = makeScene({ verboseExtras: { rot: '45°' } })
    const lines = collect(node, { verbose: true })
    expect(lines[0]).toContain('rot=45°')
  })

  it('omits verbose extras when not provided', () => {
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
    expect(lines.some(l => l.includes('root'))).toBe(true)
    expect(lines.some(l => l.includes('hero'))).toBe(true)
  })

  it('hides non-matching siblings of a matching child', () => {
    const matching = makeScene({ name: 'hero', type: 'Sprite' })
    const sibling = makeScene({ name: 'enemy', type: 'Sprite' })
    const parent = makeScene({ name: 'root', children: [matching, sibling] })
    const lines = collect(parent, { filter: 'hero' })
    expect(lines.some(l => l.includes('enemy'))).toBe(false)
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

  it('detects extras change (e.g. tint)', () => {
    const prev = makeScene({ extras: { tint: '#ffffff' } })
    const curr = makeScene({ extras: { tint: '#ff0000' } })
    const result = diffScenes(prev, curr)
    expect(result).toContain('tint: #ffffff→#ff0000')
  })

  it('detects verbose extras change (e.g. alpha)', () => {
    const prev = makeScene({ verboseExtras: { alpha: '1' } })
    const curr = makeScene({ verboseExtras: { alpha: '0.5' } })
    const result = diffScenes(prev, curr)
    expect(result).toContain('alpha: 1→0.5')
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
