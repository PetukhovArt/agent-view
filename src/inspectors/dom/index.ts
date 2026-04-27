import type { AXNode } from '../../cdp/types.js'

export type RefEntry = {
  ref: number
  backendDOMNodeId: number
}

export type DOMSnapshotOptions = {
  filter?: string
  depth?: number
  startRef?: number
  compact?: boolean
  maxLines?: number
}

export type DOMSnapshotResult = {
  text: string
  refs: RefEntry[]
  nextRef: number
}

export type DOMCountResult = {
  count: number
}

/**
 * Compute a line-level diff between two formatted DOM texts.
 * Lines present only in `curr` → `+`; only in `prev` → `-`. Returns
 * `'No changes'` when identical.
 */
export function diffDomText(prev: string, curr: string): string {
  if (prev === curr) return 'No changes'

  const prevLines = prev.split('\n')
  const currLines = curr.split('\n')

  const prevCounts = new Map<string, number>()
  for (const line of prevLines) {
    prevCounts.set(line, (prevCounts.get(line) ?? 0) + 1)
  }

  const currCounts = new Map<string, number>()
  for (const line of currLines) {
    currCounts.set(line, (currCounts.get(line) ?? 0) + 1)
  }

  const changes: string[] = []

  for (const [line, count] of currCounts) {
    const prevCount = prevCounts.get(line) ?? 0
    const added = count - prevCount
    for (let i = 0; i < added; i++) {
      changes.push(`+ ${line}`)
    }
  }

  for (const [line, count] of prevCounts) {
    const currCount = currCounts.get(line) ?? 0
    const removed = count - currCount
    for (let i = 0; i < removed; i++) {
      changes.push(`- ${line}`)
    }
  }

  return changes.length > 0 ? changes.join('\n') : 'No changes'
}

const ALWAYS_SKIP_ROLES = new Set(['InlineTextBox'])
const SKIP_WHEN_EMPTY_ROLES = new Set(['none', 'generic', 'StaticText'])
const HARD_MAX_DEPTH = 100

type VisitContext = {
  nodeMap: Map<string, AXNode>
  lowerFilter: string | undefined
  maxDepth: number | undefined
}

function resolveNameFromChildren(node: AXNode, nodeMap: Map<string, AXNode>, depthLimit = 5): string {
  if (depthLimit <= 0 || !node.childIds) return ''
  for (const childId of node.childIds) {
    const child = nodeMap.get(childId)
    if (!child) continue
    if (child.name?.value) return child.name.value
    const desc = child.properties?.find(p => p.name === 'description')
    if (desc?.value?.value && typeof desc.value.value === 'string') return desc.value.value
    const deeper = resolveNameFromChildren(child, nodeMap, depthLimit - 1)
    if (deeper) return deeper
  }
  return ''
}

function getDescendantText(node: AXNode, nodeMap: Map<string, AXNode>, depthLimit = 10): string {
  const parts: string[] = []
  function collect(n: AXNode, depth: number): void {
    if (depth > depthLimit || !n.childIds) return
    for (const childId of n.childIds) {
      const child = nodeMap.get(childId)
      if (!child) continue
      if (child.name?.value) parts.push(child.name.value)
      const desc = child.properties?.find(p => p.name === 'description')
      if (desc?.value?.value && typeof desc.value.value === 'string') parts.push(desc.value.value)
      collect(child, depth + 1)
    }
  }
  collect(node, 0)
  return parts.join(' ').toLowerCase()
}

function hasMatchingDescendant(node: AXNode, nodeMap: Map<string, AXNode>, lowerFilter: string): boolean {
  if (!node.childIds) return false
  for (const childId of node.childIds) {
    const child = nodeMap.get(childId)
    if (!child) continue
    const childRole = child.role?.value ?? ''
    if (ALWAYS_SKIP_ROLES.has(childRole)) continue
    const childName = child.name?.value?.toLowerCase() ?? ''
    if (childName.includes(lowerFilter) || childRole.toLowerCase().includes(lowerFilter)) return true
    if (hasMatchingDescendant(child, nodeMap, lowerFilter)) return true
  }
  return false
}

function nodePassesFilter(node: AXNode, name: string, role: string, ctx: VisitContext): boolean {
  if (!ctx.lowerFilter) return true
  const lf = ctx.lowerFilter
  const matchesName = name.toLowerCase().includes(lf)
  const matchesRole = role.toLowerCase().includes(lf)
  const matchesDescendants = !matchesName && !matchesRole
    ? getDescendantText(node, ctx.nodeMap, 10).includes(lf)
    : false
  return matchesName || matchesRole || matchesDescendants || hasMatchingDescendant(node, ctx.nodeMap, lf)
}

function walkVisibleNodes(
  nodeId: string,
  indent: number,
  ctx: VisitContext,
  onVisit: (node: AXNode, name: string, isFallback: boolean, indent: number) => void,
): void {
  if (indent > HARD_MAX_DEPTH) return
  if (ctx.maxDepth !== undefined && indent > ctx.maxDepth) return

  const node = ctx.nodeMap.get(nodeId)
  if (!node) return

  const role = node.role?.value ?? ''
  const ownName = node.name?.value ?? ''
  const fallbackName = !ownName ? resolveNameFromChildren(node, ctx.nodeMap) : ''
  const name = ownName || fallbackName

  if (ALWAYS_SKIP_ROLES.has(role)) return

  const skip = SKIP_WHEN_EMPTY_ROLES.has(role) && !name

  if (!skip) {
    if (nodePassesFilter(node, name, role, ctx)) {
      onVisit(node, name, !ownName && !!fallbackName, indent)
    } else {
      return
    }
  }

  if (node.childIds) {
    for (const childId of node.childIds) {
      walkVisibleNodes(childId, skip ? indent : indent + 1, ctx, onVisit)
    }
  }
}

function effectiveChildren(node: AXNode, nodeMap: Map<string, AXNode>): string[] {
  if (!node.childIds) return []
  return node.childIds.filter(childId => {
    const child = nodeMap.get(childId)
    if (!child) return false
    const childRole = child.role?.value ?? ''
    if (ALWAYS_SKIP_ROLES.has(childRole)) return false
    const childName = child.name?.value ?? ''
    const fallback = !childName ? resolveNameFromChildren(child, nodeMap) : ''
    const resolvedName = childName || fallback
    if (SKIP_WHEN_EMPTY_ROLES.has(childRole) && !resolvedName) return false
    return true
  })
}

export function formatAccessibilityTree(
  nodes: AXNode[],
  options: DOMSnapshotOptions = {},
): DOMSnapshotResult {
  const { filter, depth: maxDepth, compact = false, maxLines } = options
  const refs: RefEntry[] = []
  let nextRef = options.startRef ?? 1
  const lines: string[] = []

  const nodeMap = new Map<string, AXNode>()
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node)
  }

  const rootNodeId = nodes[0]?.nodeId
  if (!rootNodeId) return { text: '(empty)', refs: [], nextRef }

  const ctx: VisitContext = { nodeMap, lowerFilter: filter?.toLowerCase(), maxDepth }

  if (!compact) {
    walkVisibleNodes(rootNodeId, 0, ctx, (node, name, isFallback, indent) => {
      const ref = nextRef++
      if (node.backendDOMNodeId) {
        refs.push({ ref, backendDOMNodeId: node.backendDOMNodeId })
      }
      const padding = '  '.repeat(indent)
      const role = node.role?.value ?? ''
      const nameStr = name ? ` "${name}"${isFallback ? ' [fallback]' : ''}` : ''
      lines.push(`${padding}${role}${nameStr} [ref=${ref}]`)
    })
  } else {
    walkCompact(rootNodeId, 0, [], 0, ctx, {
      allocRef: (backendDOMNodeId) => {
        const ref = nextRef++
        if (backendDOMNodeId !== undefined) {
          refs.push({ ref, backendDOMNodeId })
        }
        return ref
      },
      pushLine: (line) => lines.push(line),
    })
  }

  const displayLines = maxLines !== undefined && lines.length > maxLines
    ? [...lines.slice(0, maxLines - 1), `… ${lines.length - (maxLines - 1)} more nodes`]
    : lines

  return {
    text: displayLines.join('\n') || '(no matching elements)',
    refs,
    nextRef,
  }
}

type CompactSink = {
  allocRef: (backendDOMNodeId: number | undefined) => number
  pushLine: (line: string) => void
}

function walkCompact(
  nodeId: string,
  indent: number,
  chain: string[],
  chainIndent: number,
  ctx: VisitContext,
  sink: CompactSink,
): void {
  if (indent > HARD_MAX_DEPTH) return
  if (ctx.maxDepth !== undefined && indent > ctx.maxDepth) return

  const node = ctx.nodeMap.get(nodeId)
  if (!node) return

  const role = node.role?.value ?? ''
  const ownName = node.name?.value ?? ''
  const fallbackName = !ownName ? resolveNameFromChildren(node, ctx.nodeMap) : ''
  const name = ownName || fallbackName

  if (ALWAYS_SKIP_ROLES.has(role)) return

  const skip = SKIP_WHEN_EMPTY_ROLES.has(role) && !name

  if (skip) {
    if (node.childIds) {
      for (const childId of node.childIds) {
        walkCompact(childId, indent, chain, chainIndent, ctx, sink)
      }
    }
    return
  }

  if (!nodePassesFilter(node, name, role, ctx)) return

  const ref = sink.allocRef(node.backendDOMNodeId)
  const effChildren = effectiveChildren(node, ctx.nodeMap)
  const isSingleChild = effChildren.length === 1

  if (isSingleChild && !ownName) {
    walkCompact(effChildren[0], indent + 1, [...chain, role], chainIndent, ctx, sink)
    return
  }

  const isFallback = !ownName && !!fallbackName
  const nameStr = name ? ` "${name}"${isFallback ? ' [fallback]' : ''}` : ''
  const padding = '  '.repeat(chainIndent)
  const chainPrefix = chain.length > 0 ? `${chain.join(' > ')} > ` : ''
  sink.pushLine(`${padding}${chainPrefix}${role}${nameStr} [ref=${ref}]`)

  if (node.childIds) {
    for (const childId of node.childIds) {
      walkCompact(childId, indent + 1, [], chainIndent + 1, ctx, sink)
    }
  }
}

export function countAccessibilityNodes(
  nodes: AXNode[],
  options: Pick<DOMSnapshotOptions, 'filter' | 'depth'> = {},
): DOMCountResult {
  const nodeMap = new Map<string, AXNode>()
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node)
  }

  const rootNodeId = nodes[0]?.nodeId
  if (!rootNodeId) return { count: 0 }

  const ctx: VisitContext = { nodeMap, lowerFilter: options.filter?.toLowerCase(), maxDepth: options.depth }
  let count = 0

  walkVisibleNodes(rootNodeId, 0, ctx, () => { count++ })

  return { count }
}
