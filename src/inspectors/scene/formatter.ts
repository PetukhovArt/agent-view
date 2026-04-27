import type { SceneNode, SceneOptions } from './types.js'

const HARD_MAX_DEPTH = 100

export function formatNode(node: SceneNode, depth: number, lines: string[], options: SceneOptions): void {
  if (depth > HARD_MAX_DEPTH) return
  if (options.depth !== undefined && depth > options.depth) return

  const lowerFilter = options.filter?.toLowerCase()
  if (lowerFilter && !subtreeMatches(node, lowerFilter)) return

  if (options.compact) {
    formatNodeCompact(node, depth, lines, options)
  } else {
    lines.push(formatLine(node, depth, options))
    for (const child of node.children ?? []) {
      formatNode(child, depth + 1, lines, options)
    }
  }
}

/**
 * Compact mode: merge single-child chains onto one line separated by " > ".
 * Multi-child nodes render normally (each child on its own line).
 */
function formatNodeCompact(node: SceneNode, depth: number, lines: string[], options: SceneOptions): void {
  const chain = collectSingleChildChain(node, options)
  const tail = chain[chain.length - 1]
  const tailChildren = tail.children ?? []

  const chainParts = chain.map(n => nodeLabel(n, options))
  const indent = '  '.repeat(depth)
  lines.push(`${indent}${chainParts.join(' > ')}`)

  for (const child of tailChildren) {
    formatNodeCompact(child, depth + 1, lines, options)
  }
}

/**
 * Walk down while the current node has exactly one child (and that child
 * passes the depth limit). Returns every node in the single-child chain,
 * including the node that breaks the pattern (0 or 2+ children).
 */
function collectSingleChildChain(node: SceneNode, options: SceneOptions): SceneNode[] {
  const chain: SceneNode[] = [node]
  let current = node
  while (true) {
    const children = current.children ?? []
    if (children.length !== 1) break
    const next = children[0]
    if (options.depth !== undefined) {
      // depth limit: stop chaining if we'd exceed it
      const nextDepth = chain.length // relative depth from start of chain
      if (nextDepth > options.depth) break
    }
    chain.push(next)
    current = next
  }
  return chain
}

/** Single-node label without indent — used inside compact chains. */
function nodeLabel(node: SceneNode, options: SceneOptions): string {
  const vis = node.visible ? '' : ' [hidden]'
  const nameStr = node.name ? ` "${node.name}"` : ''
  let label = `${node.type}${nameStr} (${node.x},${node.y})${vis}`

  if (node.extras) {
    for (const [key, value] of Object.entries(node.extras)) {
      label += ` ${key}=${value}`
    }
  }
  if (options.verbose && node.verboseExtras) {
    for (const [key, value] of Object.entries(node.verboseExtras)) {
      label += ` ${key}=${value}`
    }
  }
  return label
}

function formatLine(node: SceneNode, depth: number, options: SceneOptions): string {
  const indent = '  '.repeat(depth)
  return `${indent}${nodeLabel(node, options)}`
}

function subtreeMatches(node: SceneNode, lowerFilter: string): boolean {
  if (
    node.name.toLowerCase().includes(lowerFilter) ||
    node.type.toLowerCase().includes(lowerFilter)
  ) {
    return true
  }
  return (node.children ?? []).some(child => subtreeMatches(child, lowerFilter))
}

export function diffScenes(prev: SceneNode, curr: SceneNode): string {
  const changes: string[] = []
  diffNode(prev, curr, 0, changes)
  return changes.length > 0 ? changes.join('\n') : 'No changes'
}

function diffNode(prev: SceneNode, curr: SceneNode, depth: number, changes: string[]): void {
  if (depth > HARD_MAX_DEPTH) return
  const indent = '  '.repeat(depth)
  const nameStr = curr.name ? ` "${curr.name}"` : ''
  const diffs: string[] = []

  if (prev.x !== curr.x || prev.y !== curr.y) {
    diffs.push(`pos: (${prev.x},${prev.y})→(${curr.x},${curr.y})`)
  }
  if (prev.visible !== curr.visible) {
    diffs.push(`visible: ${prev.visible}→${curr.visible}`)
  }
  diffExtras(prev, curr, diffs)

  if (diffs.length > 0) {
    changes.push(`${indent}~ ${curr.type}${nameStr}: ${diffs.join(', ')}`)
  }

  diffChildren(prev, curr, depth, changes, indent)
}

function diffExtras(prev: SceneNode, curr: SceneNode, diffs: string[]): void {
  const prevAll = mergeExtras(prev)
  const currAll = mergeExtras(curr)
  const keys = new Set([...Object.keys(prevAll), ...Object.keys(currAll)])
  for (const key of keys) {
    const before = prevAll[key]
    const after = currAll[key]
    if (before !== after) {
      diffs.push(`${key}: ${before ?? '∅'}→${after ?? '∅'}`)
    }
  }
}

function mergeExtras(node: SceneNode): Record<string, string> {
  return { ...(node.extras ?? {}), ...(node.verboseExtras ?? {}) }
}

function diffChildren(
  prev: SceneNode,
  curr: SceneNode,
  depth: number,
  changes: string[],
  indent: string,
): void {
  const prevChildren = prev.children ?? []
  const currChildren = curr.children ?? []
  const prevByKey = new Map(prevChildren.map((c, i) => [childKey(c, i), c]))
  const currByKey = new Map(currChildren.map((c, i) => [childKey(c, i), c]))

  for (const [key, child] of currByKey) {
    const prevChild = prevByKey.get(key)
    if (!prevChild) {
      changes.push(`${indent}  + ${child.type}${child.name ? ` "${child.name}"` : ''} (${child.x},${child.y})`)
    } else {
      diffNode(prevChild, child, depth + 1, changes)
    }
  }

  for (const [key, child] of prevByKey) {
    if (!currByKey.has(key)) {
      changes.push(`${indent}  - ${child.type}${child.name ? ` "${child.name}"` : ''} (${child.x},${child.y})`)
    }
  }
}

function childKey(node: SceneNode, index: number): string {
  return node.name ? `${node.type}:${node.name}` : `${node.type}:${index}`
}
