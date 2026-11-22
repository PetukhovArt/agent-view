import { describe, expect, it } from 'vitest'
import { runSceneRules } from '../scene.js'
import type { SceneNode } from '../../scene/types.js'

const viewport = { width: 800, height: 600 }

const text = (id: string, x: number, y: number, width: number, height: number, extra: Partial<SceneNode> = {}): SceneNode =>
  ({ type: 'Text', name: id, id, visible: true, bounds: { x, y, width, height }, ...extra })

const scene = (...children: SceneNode[]): SceneNode => ({ type: 'Scene', name: '', visible: true, children })

const legend: SceneNode = { type: 'panel', name: 'Legend', id: 'legend', visible: true, bounds: { x: 20, y: 20, width: 200, height: 100 } }

const flagged = (root: SceneNode): string[] => runSceneRules(root, viewport).map(f => `${f.rule} ${f.target.testid}`)

describe('runSceneRules', () => {
  it('flags text outside its parent, intersecting sibling text and text across the viewport edge, and nothing else', () => {
    const root = scene(
      { ...legend, children: [
        text('out', 150, 100, 120, 20), text('a', 30, 60, 100, 16), text('b', 90, 66, 100, 16),
        text('next', 130, 30, 60, 20), text('title', 30, 30, 100, 20), text('ghost', 30, 60, 100, 16, { visible: false }),
      ] },
      text('edge', 740, 300, 120, 16),
      text('parked', 900, 300, 120, 16),
      { type: 'layer', name: 'Basemap', visible: true, bounds: { x: 0, y: 0, width: 2000, height: 2000 } },
    )
    expect(flagged(root)).toEqual(['scene-text-out out', 'scene-overlap a', 'scene-offscreen edge'])
  })

  it('takes the parent of a node in a flat list from its parent id', () => {
    expect(flagged(scene(legend, text('out', 150, 100, 120, 20, { parent: 'legend' })))).toEqual(['scene-text-out out'])
  })
})
