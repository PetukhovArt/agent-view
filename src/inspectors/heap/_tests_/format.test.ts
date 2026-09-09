import { describe, it, expect } from 'vitest'
import { parseHeapSnapshot, formatDiff, formatRetainers, formatSummary } from '../index.js'

// A minimal V8 heap snapshot in the real wire layout: flat `nodes` / `edges`
// arrays indexed through `meta`. The parser reads offsets from `meta`, never
// hardcodes them, so field order here is deliberately not V8's default.
type N = { type: string; name: string; size: number; detached?: number; edges?: Array<{ type: string; name: string | number; to: number }> }

const NODE_TYPES = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic']
const EDGE_TYPES = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']
const NODE_FIELDS = ['name', 'type', 'self_size', 'edge_count', 'detachedness']

function snapshot(list: N[], name = 's', target = 'page:App'): ReturnType<typeof parseHeapSnapshot> {
  const strings: string[] = []
  const str = (s: string) => { let i = strings.indexOf(s); if (i < 0) { i = strings.length; strings.push(s) } return i }
  const nodes: number[] = []
  const edges: number[] = []
  for (const n of list) {
    nodes.push(str(n.name), NODE_TYPES.indexOf(n.type), n.size, n.edges?.length ?? 0, n.detached ?? 0)
    for (const e of n.edges ?? []) {
      edges.push(EDGE_TYPES.indexOf(e.type), typeof e.name === 'number' ? e.name : str(e.name), e.to * NODE_FIELDS.length)
    }
  }
  const json = JSON.stringify({
    snapshot: { meta: { node_fields: NODE_FIELDS, node_types: [NODE_TYPES], edge_fields: ['type', 'name_or_index', 'to_node'], edge_types: [EDGE_TYPES] } },
    nodes, edges, strings,
  })
  return parseHeapSnapshot(json, name, target)
}

describe('heap snapshot', () => {
  // A detached wrapper hidden inside the attached class is the one thing this
  // command exists to expose; both V8 encodings (field and name prefix) occur.
  it('splits detached DOM wrappers into their own class from either encoding', () => {
    const s = snapshot([
      { type: 'native', name: 'HTMLDivElement', size: 10, detached: 1 },
      { type: 'native', name: 'HTMLDivElement', size: 10, detached: 2 },
      { type: 'native', name: 'Detached HTMLDivElement', size: 10 },
    ])
    expect(s.classes.get('HTMLDivElement')).toEqual({ count: 1, size: 10 })
    expect(s.classes.get('Detached HTMLDivElement')).toEqual({ count: 2, size: 20 })
    expect(formatSummary(s, { detached: true })).toContain('2 detached DOM nodes (20 B)')
  })

  it('diffs classes by count and size, largest growth first', () => {
    const a = snapshot([{ type: 'object', name: 'Row', size: 8 }, { type: 'string', name: 'x', size: 4 }], 'baseline')
    const b = snapshot([
      { type: 'object', name: 'Row', size: 8 }, { type: 'object', name: 'Row', size: 8 },
      { type: 'object', name: 'Cell', size: 100 },
    ], 'target')
    const lines = formatDiff(a, b).split('\n')
    expect(lines[0]).toBe('baseline → target (page:App): +1 nodes, +104 B, detached 0 (0 B)')
    expect(lines[2]).toMatch(/^Cell\s+\+1\s+\+100 B\s+1$/)
    expect(lines[3]).toMatch(/^Row\s+\+1\s+\+8 B\s+2$/)
    expect(lines[4]).toMatch(/^\(string\)\s+-1\s+-4 B\s+0$/)
  })

  it('names the retainer and edge, folds V8 element stores into their owner, skips weak edges', () => {
    // V8 reports an Array's items twice (own element edges + backing store); both must land in one row.
    const s = snapshot([
      { type: 'object', name: 'Array', size: 0, edges: [{ type: 'internal', name: 'elements', to: 1 }, { type: 'element', name: 0, to: 3 }, { type: 'element', name: 1, to: 4 }] },
      { type: 'array', name: '(object elements)', size: 0, edges: [{ type: 'internal', name: '0', to: 3 }, { type: 'internal', name: '1', to: 4 }] },
      { type: 'object', name: 'Registry', size: 0, edges: [{ type: 'property', name: 'el', to: 3 }, { type: 'weak', name: 'ref', to: 4 }] },
      { type: 'native', name: '<div class="row">', size: 10, detached: 2 },
      { type: 'native', name: '<div class="row">', size: 10, detached: 2 },
    ])
    const lines = formatRetainers(s, 'Detached <div class="row">').split('\n')
    expect(lines[0]).toBe('Detached <div class="row"> ×2 in "s", retained by:')
    expect(lines[2]).toMatch(/^Array \[\]\s+2$/)
    expect(lines[3]).toMatch(/^Registry \.el\s+1$/)
    expect(lines).toHaveLength(4)
  })

  it('walks a store chain to the first non-store owner', () => {
    // Map → (hidden) table → (object elements) → value: two internal hops before a name a developer wrote.
    const s = snapshot([
      { type: 'object', name: 'Map', size: 0, edges: [{ type: 'internal', name: 'table', to: 1 }] },
      { type: 'hidden', name: 'system / OrderedHashMap', size: 0, edges: [{ type: 'internal', name: 'elements', to: 2 }] },
      { type: 'array', name: '(object elements)', size: 0, edges: [{ type: 'internal', name: '3', to: 3 }] },
      { type: 'object', name: 'Session', size: 4 },
    ])
    expect(formatRetainers(s, 'Session').split('\n')[2]).toMatch(/^Map \[\]\s+1$/)
  })
})
