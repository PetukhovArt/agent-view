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
}

export type DOMSnapshotResult = {
  text: string
  refs: RefEntry[]
  nextRef: number
}

export function formatAccessibilityTree(
  nodes: AXNode[],
  options: DOMSnapshotOptions = {},
): DOMSnapshotResult {
  const { filter, depth: maxDepth, compact = false } = options
  const refs: RefEntry[] = []
  let nextRef = options.startRef ?? 1
  const lines: string[] = []

  const nodeMap = new Map<string, AXNode>()
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node)
  }

  const rootNodeId = nodes[0]?.nodeId
  if (!rootNodeId) return { text: '(empty)', refs: [], nextRef }

  const ALWAYS_SKIP_ROLES = new Set(['InlineTextBox'])
  const SKIP_WHEN_EMPTY_ROLES = new Set(['none', 'generic', 'StaticText'])

  // WAI-ARIA-like fallback: when a node has no accessible name,
  // walk its children to find the first non-empty name, description, or title.
  // This handles cases like v-list-item with title on a child v-icon.
  function resolveNameFromChildren(node: AXNode, depthLimit = 5): string {
    if (depthLimit <= 0 || !node.childIds) return ''
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId)
      if (!child) continue
      // Check child's own name
      if (child.name?.value) return child.name.value
      // Check description/title in AX properties
      const desc = child.properties?.find(p => p.name === 'description')
      if (desc?.value?.value && typeof desc.value.value === 'string') return desc.value.value
      // Recurse into grandchildren
      const deeper = resolveNameFromChildren(child, depthLimit - 1)
      if (deeper) return deeper
    }
    return ''
  }

  // Collect all descendant text for heuristic filter matching.
  // Searches name and description of all descendants, not just current node.
  function getDescendantText(node: AXNode, depthLimit = 10): string {
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

  function hasMatchingDescendant(node: AXNode, lowerFilter: string): boolean {
    if (!node.childIds) return false
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId)
      if (!child) continue
      const childRole = child.role?.value ?? ''
      if (ALWAYS_SKIP_ROLES.has(childRole)) continue
      const childName = child.name?.value?.toLowerCase() ?? ''
      if (childName.includes(lowerFilter) || childRole.toLowerCase().includes(lowerFilter)) return true
      if (hasMatchingDescendant(child, lowerFilter)) return true
    }
    return false
  }

  // Returns the renderable (non-skipped) child IDs for a given node,
  // accounting for ALWAYS_SKIP_ROLES and SKIP_WHEN_EMPTY_ROLES.
  function effectiveChildren(node: AXNode): string[] {
    if (!node.childIds) return []
    return node.childIds.filter(childId => {
      const child = nodeMap.get(childId)
      if (!child) return false
      const childRole = child.role?.value ?? ''
      if (ALWAYS_SKIP_ROLES.has(childRole)) return false
      const childName = child.name?.value ?? ''
      const fallback = !childName ? resolveNameFromChildren(child) : ''
      const resolvedName = childName || fallback
      if (SKIP_WHEN_EMPTY_ROLES.has(childRole) && !resolvedName) return false
      return true
    })
  }

  const HARD_MAX_DEPTH = 100

  // chain: roles of ancestor nodes merged onto this line (compact mode only).
  // chainIndent: the indent at which the chain started (where the line will be emitted).
  function walk(nodeId: string, depth: number, indent: number, chain: string[], chainIndent: number): void {
    if (indent > HARD_MAX_DEPTH) return
    if (maxDepth !== undefined && indent > maxDepth) return

    const node = nodeMap.get(nodeId)
    if (!node) return

    const role = node.role?.value ?? ''
    const ownName = node.name?.value ?? ''
    // Fallback: resolve name from children when node has no accessible name
    const fallbackName = !ownName ? resolveNameFromChildren(node) : ''
    const name = ownName || fallbackName

    if (ALWAYS_SKIP_ROLES.has(role)) return

    const skip = SKIP_WHEN_EMPTY_ROLES.has(role) && !name

    if (!skip) {
      if (filter) {
        const lowerFilter = filter.toLowerCase()
        const matchesName = name.toLowerCase().includes(lowerFilter)
        const matchesRole = role.toLowerCase().includes(lowerFilter)
        // Heuristic: also search descendant names/descriptions
        const matchesDescendants = !matchesName && !matchesRole
          ? getDescendantText(node, 10).includes(lowerFilter)
          : false
        if (!matchesName && !matchesRole && !matchesDescendants && !hasMatchingDescendant(node, lowerFilter)) {
          return
        }
      }

      const ref = nextRef++
      if (node.backendDOMNodeId) {
        refs.push({ ref, backendDOMNodeId: node.backendDOMNodeId })
      }

      const effChildren = compact ? effectiveChildren(node) : []
      const isSingleChild = effChildren.length === 1

      if (compact && isSingleChild && !ownName) {
        // This node has no own accessible name and is a single-child link — accumulate into chain.
        // Ref is already registered above; it won't appear inline but remains clickable.
        walk(effChildren[0], depth + 1, indent + 1, [...chain, role], chainIndent)
      } else {
        // Flush: emit accumulated chain + this node on one line.
        const isFallback = !ownName && fallbackName
        const nameStr = name ? ` "${name}"${isFallback ? ' [fallback]' : ''}` : ''
        const padding = '  '.repeat(compact ? chainIndent : indent)
        const chainPrefix = chain.length > 0 ? `${chain.join(' > ')} > ` : ''
        lines.push(`${padding}${chainPrefix}${role}${nameStr} [ref=${ref}]`)

        if (node.childIds) {
          for (const childId of node.childIds) {
            walk(childId, depth + 1, indent + 1, [], compact ? chainIndent + 1 : indent + 1)
          }
        }
      }
    } else {
      // Skipped node — pass through children at same indent, reset chain
      if (node.childIds) {
        for (const childId of node.childIds) {
          walk(childId, depth + 1, indent, chain, chainIndent)
        }
      }
    }
  }

  walk(rootNodeId, 0, 0, [], 0)

  return {
    text: lines.join('\n') || '(no matching elements)',
    refs,
    nextRef,
  }
}
