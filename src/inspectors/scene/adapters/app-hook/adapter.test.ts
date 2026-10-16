import { describe, expect, it } from 'vitest'
import { appHookAdapter } from './adapter.js'

describe('appHookAdapter.normalize', () => {
  it('roots the hook nodes under one Scene node, extras as strings, a half point dropped', () => {
    const nodes = [
      { type: 'marker', name: 'Tower 3', x: 640, y: 410, visible: true, extras: { id: 't3', size: 2 } },
      { type: 'zone', name: '', x: 12, y: null, visible: false, children: [{ type: 'marker', name: 'Gate', visible: true }] },
    ]
    expect(appHookAdapter.normalize(nodes)).toEqual({
      type: 'Scene', name: '', visible: true, children: [
        { type: 'marker', name: 'Tower 3', x: 640, y: 410, visible: true, extras: { id: 't3', size: '2' } },
        { type: 'zone', name: '', visible: false, children: [{ type: 'marker', name: 'Gate', visible: true }] },
      ],
    })
  })

  it('refuses no hook, and a node of another shape at any depth', () => {
    expect(appHookAdapter.normalize(null)).toBeNull()
    expect(appHookAdapter.normalize([{ type: 'zone', name: '', visible: true, children: [{ name: 'Gate' }] }])).toBeNull()
  })
})
