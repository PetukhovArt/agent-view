import type { AXNode } from '../../cdp/types.js'

export type RefEntry = {
  ref: number
  backendDOMNodeId: number
}

export type DOMSnapshotOptions = {
  filter?: string
  depth?: number
  startRef?: number
}

export type DOMSnapshotResult = {
  text: string
  refs: RefEntry[]
  nextRef: number
}

export type DOMCountResult = {
  count: number
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

// Collect all descendant text for heuristic filter matching.
// Searches name and description of all descendants, not just current node.
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

export function formatAccessibilityTree(
  nodes: AXNode[],
  options: DOMSnapshotOptions = {},
): DOMSnapshotResult {
  const { filter, depth: maxDepth } = options
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

  return {
    text: lines.join('\n') || '(no matching elements)',
    refs,
    nextRef,
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
