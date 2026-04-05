import type { SceneNode, SceneOptions } from './types.js'

const HARD_MAX_DEPTH = 100

export function formatNode(node: SceneNode, depth: number, lines: string[], options: SceneOptions): void {
  if (depth > HARD_MAX_DEPTH) return
  if (options.depth !== undefined && depth > options.depth) return

  const matchesFilter = !options.filter ||
    node.name.toLowerCase().includes(options.filter.toLowerCase()) ||
    node.type.toLowerCase().includes(options.filter.toLowerCase())

  const hasMatchingChildren = options.filter
    ? (node.children || []).some(c => hasMatch(c, options.filter!))
    : false

  if (matchesFilter || hasMatchingChildren) {
    const indent = '  '.repeat(depth)
    const vis = node.visible ? '' : ' [hidden]'
    const nameStr = node.name ? ` "${node.name}"` : ''
    let line = `${indent}${node.type}${nameStr} (${node.x},${node.y})${vis}`

    if (node.tint !== '0xffffff' && node.tint !== '#ffffff') {
      line += ` tint=${node.tint}`
    }

    if (options.verbose) {
      const extras: string[] = []
      if (node.alpha !== undefined && node.alpha !== 1) extras.push(`alpha=${node.alpha}`)
      if (node.scaleX !== 1 || node.scaleY !== 1) extras.push(`scale=(${node.scaleX},${node.scaleY})`)
      if (node.rotation !== 0) extras.push(`rot=${node.rotation}°`)
      if (node.width || node.height) extras.push(`size=${node.width}x${node.height}`)
      if (extras.length > 0) line += ` ${extras.join(' ')}`
    }

    lines.push(line)
  }

  for (const child of node.children || []) {
    formatNode(child, depth + 1, lines, options)
  }
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

  if (prev.x !== curr.x || prev.y !== curr.y) diffs.push(`pos: (${prev.x},${prev.y})→(${curr.x},${curr.y})`)
  if (prev.visible !== curr.visible) diffs.push(`visible: ${prev.visible}→${curr.visible}`)
  if (prev.tint !== curr.tint) diffs.push(`tint: ${prev.tint}→${curr.tint}`)
  if (prev.alpha !== curr.alpha) diffs.push(`alpha: ${prev.alpha}→${curr.alpha}`)

  if (diffs.length > 0) {
    changes.push(`${indent}~ ${curr.type}${nameStr}: ${diffs.join(', ')}`)
  }

  const prevChildren = prev.children || []
  const currChildren = curr.children || []
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

export function hasMatch(node: SceneNode, filter: string): boolean {
  const lower = filter.toLowerCase()
  if (node.name.toLowerCase().includes(lower) || node.type.toLowerCase().includes(lower)) {
    return true
  }
  return (node.children || []).some(c => hasMatch(c, lower))
}
