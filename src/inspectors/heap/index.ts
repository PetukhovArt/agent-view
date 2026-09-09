/**
 * V8 `.heapsnapshot` reader, sized for one question: what grew between two
 * snapshots, and who holds it. Retained sizes and dominator trees are out of
 * scope on purpose — they are where the DevTools engine spends its 5,000 lines,
 * and "which class grew, is it detached DOM, what retains it" needs neither.
 */

import { capLines, formatBytes as fmtBytes } from '../format.js'

type Meta = {
  node_fields: string[]
  node_types: [string[], ...unknown[]]
  edge_fields: string[]
  edge_types: [string[], ...unknown[]]
}

type RawSnapshot = {
  snapshot: { meta: Meta }
  nodes: number[]
  edges: number[]
  strings: string[]
}

export type ClassStat = { count: number; size: number }

export type HeapSnapshot = {
  name: string
  target: string
  nodeCount: number
  totalSize: number
  classes: Map<string, ClassStat>
  /** Retainer lookup needs the graph itself; kept as typed arrays, not as parsed JSON. */
  graph: HeapGraph
}

type HeapGraph = {
  nodes: Uint32Array
  edges: Uint32Array
  strings: string[]
  nodeFieldCount: number
  edgeFieldCount: number
  nodeTypes: string[]
  edgeTypes: string[]
  /** Field offsets inside one node / edge record. `detachedness` is -1 on V8 builds that predate it. */
  nType: number
  nName: number
  nSize: number
  nEdgeCount: number
  nDetached: number
  eType: number
  eName: number
  eTo: number
}

const DETACHED = 2
const DETACHED_PREFIX = 'Detached '

export function parseHeapSnapshot(json: string, name: string, target: string): HeapSnapshot {
  const raw = JSON.parse(json) as RawSnapshot
  const { meta } = raw.snapshot
  const graph: HeapGraph = {
    nodes: Uint32Array.from(raw.nodes),
    edges: Uint32Array.from(raw.edges),
    strings: raw.strings,
    nodeFieldCount: meta.node_fields.length,
    edgeFieldCount: meta.edge_fields.length,
    nodeTypes: meta.node_types[0],
    edgeTypes: meta.edge_types[0],
    nType: meta.node_fields.indexOf('type'),
    nName: meta.node_fields.indexOf('name'),
    nSize: meta.node_fields.indexOf('self_size'),
    nEdgeCount: meta.node_fields.indexOf('edge_count'),
    nDetached: meta.node_fields.indexOf('detachedness'),
    eType: meta.edge_fields.indexOf('type'),
    eName: meta.edge_fields.indexOf('name_or_index'),
    eTo: meta.edge_fields.indexOf('to_node'),
  }

  const classes = new Map<string, ClassStat>()
  let totalSize = 0
  const nodeCount = graph.nodes.length / graph.nodeFieldCount
  for (let i = 0; i < nodeCount; i++) {
    const off = i * graph.nodeFieldCount
    const cls = classOf(graph, off)
    const size = graph.nodes[off + graph.nSize]
    const stat = classes.get(cls) ?? { count: 0, size: 0 }
    stat.count++
    stat.size += size
    classes.set(cls, stat)
    totalSize += size
  }
  return { name, target, nodeCount, totalSize, classes, graph }
}

/**
 * DevTools' grouping, minus its per-constructor heuristics: objects and DOM
 * wrappers by name, everything else by V8 type. A detached DOM wrapper becomes
 * its own class so it stands out in a diff instead of hiding among the
 * attached ones.
 */
function classOf(g: HeapGraph, off: number): string {
  const type = g.nodeTypes[g.nodes[off + g.nType]]
  const name = g.strings[g.nodes[off + g.nName]]
  switch (type) {
    case 'object':
    case 'native':
    case 'synthetic': {
      if (name.startsWith(DETACHED_PREFIX)) return name
      const detached = g.nDetached >= 0 && g.nodes[off + g.nDetached] === DETACHED
      return detached ? DETACHED_PREFIX + name : name
    }
    case 'closure':
      return name ? `${name}()` : '(closure)'
    case 'string':
    case 'concatenated string':
    case 'sliced string':
      return '(string)'
    case 'code':
      return '(compiled code)'
    default:
      return `(${type})`
  }
}

export function isDetachedClass(cls: string): boolean {
  return cls.startsWith(DETACHED_PREFIX)
}

export type ListOptions = {
  filter?: string
  detached?: boolean
  maxLines?: number
}

function keep(cls: string, options: ListOptions): boolean {
  if (options.detached && !isDetachedClass(cls)) return false
  if (options.filter && !cls.toLowerCase().includes(options.filter.toLowerCase())) return false
  return true
}

export function describeSnapshot(s: HeapSnapshot): string {
  const detached = sumDetached(s.classes)
  return `Snapshot "${s.name}" (${s.target}): ${fmtCount(s.nodeCount)} nodes, ${fmtBytes(s.totalSize)}, `
    + `${fmtCount(detached.count)} detached DOM nodes (${fmtBytes(detached.size)})`
}

function sumDetached(classes: Map<string, ClassStat>): ClassStat {
  const out = { count: 0, size: 0 }
  for (const [cls, stat] of classes) {
    if (isDetachedClass(cls)) { out.count += stat.count; out.size += stat.size }
  }
  return out
}

export function formatSummary(s: HeapSnapshot, options: ListOptions = {}): string {
  const rows = [...s.classes].filter(([cls]) => keep(cls, options)).sort((a, b) => b[1].size - a[1].size)
  if (rows.length === 0) return `(no class matching ${describeFilter(options)} in "${s.name}")`
  const lines = [describeSnapshot(s), ...table(
    ['class', 'count', 'size'],
    rows.map(([cls, st]) => [cls, fmtCount(st.count), fmtBytes(st.size)]),
  )]
  return capLines(lines, options.maxLines)
}

export function formatDiff(a: HeapSnapshot, b: HeapSnapshot, options: ListOptions = {}): string {
  const rows: Array<[string, number, number, number]> = []
  for (const cls of new Set([...a.classes.keys(), ...b.classes.keys()])) {
    if (!keep(cls, options)) continue
    const before = a.classes.get(cls) ?? { count: 0, size: 0 }
    const after = b.classes.get(cls) ?? { count: 0, size: 0 }
    const dCount = after.count - before.count
    const dSize = after.size - before.size
    if (dCount !== 0 || dSize !== 0) rows.push([cls, dCount, dSize, after.count])
  }
  if (rows.length === 0) {
    const scope = options.filter || options.detached ? ` matching ${describeFilter(options)}` : ''
    return `(no class changed between "${a.name}" and "${b.name}"${scope})`
  }
  rows.sort((x, y) => y[2] - x[2] || y[1] - x[1])
  const dA = sumDetached(a.classes)
  const dB = sumDetached(b.classes)
  const head = `${a.name} → ${b.name} (${b.target}): ${fmtDelta(b.nodeCount - a.nodeCount)} nodes, `
    + `${fmtDelta(b.totalSize - a.totalSize, true)}, detached ${fmtDelta(dB.count - dA.count)} (${fmtDelta(dB.size - dA.size, true)})`
  const lines = [head, ...table(
    ['class', 'Δcount', 'Δsize', 'count'],
    rows.map(([cls, dc, ds, c]) => [cls, fmtDelta(dc), fmtDelta(ds, true), fmtCount(c)]),
  )]
  return capLines(lines, options.maxLines)
}

/**
 * Who holds the instances of `cls`: one row per `<retainer class> <edge>`,
 * counting distinct instances, not edges. Element indices collapse to `[]`, so
 * an array of 200 leaks is one row. Weak edges keep nothing alive and are
 * skipped.
 *
 * V8 reports an array's items twice, once from the `Array` and once from its
 * `(object elements)` backing store, and a Map's entries only from the store.
 * Stores name nothing a developer wrote, so an edge from one is attributed to
 * the store's owner; counting instances makes the duplicate collapse. Still one
 * named hop, no path to a GC root: the first owner is usually the map, list or
 * closure at fault. Instances holding each other (DOM sibling links, list
 * nodes) are left out: they never explain why the group is alive.
 */
export function formatRetainers(s: HeapSnapshot, cls: string, options: Pick<ListOptions, 'maxLines'> = {}): string {
  const g = s.graph
  const nodeCount = g.nodes.length / g.nodeFieldCount
  const classCache = new Map<number, string>()
  const clsAt = (off: number) => {
    let c = classCache.get(off)
    if (c === undefined) { c = classOf(g, off); classCache.set(off, c) }
    return c
  }
  const weak = g.edgeTypes.indexOf('weak')
  const indexed = new Set([g.edgeTypes.indexOf('element'), g.edgeTypes.indexOf('hidden')])
  const stores = new Set([g.nodeTypes.indexOf('array'), g.nodeTypes.indexOf('hidden')])
  const isStore = (off: number) => stores.has(g.nodes[off + g.nType])
  const edgeName = (edgeOff: number) => {
    if (indexed.has(g.edges[edgeOff + g.eType])) return '[]'
    const name = g.strings[g.edges[edgeOff + g.eName]]
    return /^\d+$/.test(name) ? '[]' : `.${name}`
  }

  const held = new Map<string, Set<number>>()
  const hold = (key: string, instance: number) => {
    const set = held.get(key) ?? new Set<number>()
    set.add(instance)
    held.set(key, set)
  }
  /** Store node → its edges into `cls`, awaiting the store's owner. */
  const pending = new Map<number, Array<[string, number]>>()
  let instances = 0
  let edgeOff = 0
  for (let i = 0; i < nodeCount; i++) {
    const off = i * g.nodeFieldCount
    if (clsAt(off) === cls) instances++
    const edgeCount = g.nodes[off + g.nEdgeCount]
    for (let e = 0; e < edgeCount; e++, edgeOff += g.edgeFieldCount) {
      if (g.edges[edgeOff + g.eType] === weak) continue
      const to = g.edges[edgeOff + g.eTo]
      if (clsAt(to) !== cls || clsAt(off) === cls) continue
      if (isStore(off)) {
        const list = pending.get(off) ?? []
        list.push([edgeName(edgeOff), to])
        pending.set(off, list)
      } else {
        hold(`${clsAt(off)} ${edgeName(edgeOff)}`, to)
      }
    }
  }

  foldStores(g, pending, isStore, weak, (owner, name, to) => hold(`${clsAt(owner)} ${name}`, to))

  if (instances === 0) return `(no instances of "${cls}" in "${s.name}")`
  if (held.size === 0) return `${cls} ×${fmtCount(instances)} in "${s.name}": no strong retainers (GC roots only)`
  const rows = [...held].map(([k, set]) => [k, set.size] as const).sort((a, b) => b[1] - a[1])
  const lines = [
    `${cls} ×${fmtCount(instances)} in "${s.name}", retained by:`,
    ...table(['retainer', 'instances'], rows.map(([k, n]) => [k, fmtCount(n)])),
  ]
  return capLines(lines, options.maxLines)
}

/**
 * Attribute edges out of V8 stores to the nearest non-store owner. A store's
 * owner may itself be a store (a Map's table behind its `(object elements)`),
 * so the walk repeats, bounded so a cycle of internals cannot spin it. What is
 * still unowned after that is reported under the store's own name: honest, if
 * unhelpful.
 */
function foldStores(
  g: HeapGraph,
  pending: Map<number, Array<[string, number]>>,
  isStore: (off: number) => boolean,
  weak: number,
  attribute: (owner: number, edge: string, instance: number) => void,
): void {
  const nodeCount = g.nodes.length / g.nodeFieldCount
  for (let hop = 0; hop < 3 && pending.size > 0; hop++) {
    const next = new Map<number, Array<[string, number]>>()
    let edgeOff = 0
    for (let i = 0; i < nodeCount; i++) {
      const off = i * g.nodeFieldCount
      const edgeCount = g.nodes[off + g.nEdgeCount]
      for (let e = 0; e < edgeCount; e++, edgeOff += g.edgeFieldCount) {
        if (g.edges[edgeOff + g.eType] === weak) continue
        const list = pending.get(g.edges[edgeOff + g.eTo])
        if (!list) continue
        if (isStore(off)) {
          next.set(off, [...(next.get(off) ?? []), ...list])
        } else {
          for (const [name, to] of list) attribute(off, name, to)
        }
        pending.delete(g.edges[edgeOff + g.eTo])
      }
    }
    for (const [off, list] of pending) next.set(off, [...(next.get(off) ?? []), ...list])
    pending = next
  }
  for (const [off, list] of pending) for (const [name, to] of list) attribute(off, name, to)
}

export function formatList(snapshots: HeapSnapshot[]): string {
  if (snapshots.length === 0) return '(no heap snapshots taken)'
  return snapshots.map(describeSnapshot).join('\n')
}

function describeFilter(options: ListOptions): string {
  return options.filter ? `"${options.filter}"` : 'detached'
}

function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)))
  const line = (r: string[]) => r.map((c, i) => i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i])).join('  ')
  return [line(header), ...rows.map(line)]
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-US')
}

function fmtDelta(n: number, bytes = false): string {
  const sign = n > 0 ? '+' : ''
  return sign + (bytes ? fmtBytes(n) : fmtCount(n))
}
