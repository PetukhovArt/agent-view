import type { AXNode } from '../cdp/types.js'

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

  const SKIP_ROLES = new Set(['none', 'generic', 'InlineTextBox', 'StaticText'])

  function hasMatchingDescendant(node: AXNode, lowerFilter: string): boolean {
    if (!node.childIds) return false
    for (const childId of node.childIds) {
      const child = nodeMap.get(childId)
      if (!child) continue
      const childName = child.name?.value?.toLowerCase() ?? ''
      const childRole = child.role?.value?.toLowerCase() ?? ''
      if (childName.includes(lowerFilter) || childRole.includes(lowerFilter)) return true
      if (hasMatchingDescendant(child, lowerFilter)) return true
    }
    return false
  }

  function walk(nodeId: string, depth: number, indent: number): void {
    if (maxDepth !== undefined && indent > maxDepth) return

    const node = nodeMap.get(nodeId)
    if (!node) return

    const role = node.role?.value ?? ''
    const name = node.name?.value ?? ''

    const skip = SKIP_ROLES.has(role) && !name

    if (!skip) {
      if (filter) {
        const lowerFilter = filter.toLowerCase()
        const matchesName = name.toLowerCase().includes(lowerFilter)
        const matchesRole = role.toLowerCase().includes(lowerFilter)
        if (!matchesName && !matchesRole && !hasMatchingDescendant(node, lowerFilter)) {
          return
        }
      }

      const ref = nextRef++
      if (node.backendDOMNodeId) {
        refs.push({ ref, backendDOMNodeId: node.backendDOMNodeId })
      }

      const padding = '  '.repeat(indent)
      const nameStr = name ? ` "${name}"` : ''
      lines.push(`${padding}${role}${nameStr} [ref=${ref}]`)
    }

    if (node.childIds) {
      for (const childId of node.childIds) {
        walk(childId, depth + 1, skip ? indent : indent + 1)
      }
    }
  }

  walk(rootNodeId, 0, 0)

  return {
    text: lines.join('\n') || '(no matching elements)',
    refs,
    nextRef,
  }
}
