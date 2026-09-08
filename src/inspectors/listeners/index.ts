import type { EventListenerInfo } from '../../cdp/types.js'

function flags(l: EventListenerInfo): string {
  const set: string[] = []
  if (l.useCapture) set.push('capture')
  if (l.passive) set.push('passive')
  if (l.once) set.push('once')
  return set.length > 0 ? `  (${set.join(', ')})` : ''
}

/** `scriptId` is the fallback: a script parsed after the last scan has no URL yet. */
function location(l: EventListenerInfo): string {
  const source = l.url || `scriptId:${l.scriptId}`
  return `${source}:${l.lineNumber + 1}:${l.columnNumber + 1}`
}

/** `label` echoes how the node was addressed, so the output names what it describes. */
export function formatListeners(label: string, listeners: EventListenerInfo[]): string {
  const lines = [label]

  if (listeners.length === 0) {
    lines.push('  (no listeners on this node)')
    return lines.join('\n')
  }

  const sorted = [...listeners].sort((a, b) => a.type.localeCompare(b.type) || location(a).localeCompare(location(b)))
  const width = Math.min(16, Math.max(...sorted.map((l) => l.type.length)))
  for (const l of sorted) {
    lines.push(`  ${l.type.padEnd(width)}  ${location(l)}${flags(l)}`)
  }
  return lines.join('\n')
}
