import type { CoverageScript } from '../../cdp/types.js'
import { capLines } from '../format.js'

export type CoverageOptions = {
  /** Substring matched against the function name or the script URL. */
  filter?: string
  /** Substring matched against the script URL only. */
  file?: string
  /** Keep runtime/library/eval scripts that are hidden by default. */
  all?: boolean
  maxLines?: number
}

export type CoverageResult = {
  text: string
  /** Functions left after filtering — what `--count` prints. */
  functions: number
}

/**
 * Scripts nobody reviews: the runtime's own bundles, third-party packages, and
 * code with no URL at all (`eval`, `new Function`) which cannot be pointed at in
 * a review comment. `--all` brings them back.
 */
function isNoise(url: string): boolean {
  if (url === '') return true
  return url.includes('/node_modules/')
    || url.startsWith('node:')
    || url.startsWith('chrome-extension://')
    || url.startsWith('devtools://')
    || url.startsWith('extensions::')
}

function label(fn: { name: string; offset: number }): string {
  return fn.name || `<anonymous>@${fn.offset}`
}

export function formatCoverage(scripts: CoverageScript[], options: CoverageOptions = {}): CoverageResult {
  const filter = options.filter?.toLowerCase()
  const file = options.file?.toLowerCase()

  let hidden = 0
  const kept: CoverageScript[] = []
  for (const script of scripts) {
    if (!options.all && isNoise(script.url)) { hidden++; continue }
    if (file && !script.url.toLowerCase().includes(file)) continue
    const urlMatches = filter !== undefined && script.url.toLowerCase().includes(filter)
    const functions = filter === undefined || urlMatches
      ? script.functions
      : script.functions.filter((fn) => label(fn).toLowerCase().includes(filter))
    if (functions.length > 0) kept.push({ ...script, functions })
  }

  const total = kept.reduce((n, s) => n + s.functions.length, 0)
  if (total === 0) {
    const term = options.filter ?? options.file
    return {
      text: term !== undefined ? `(no code matching "${term}")` : '(no code executed since --clear)',
      functions: 0,
    }
  }

  kept.sort((a, b) => (a.url || '￿').localeCompare(b.url || '￿'))
  const lines: string[] = []
  for (const script of kept) {
    const names = script.functions
      .map((fn) => ({ name: label(fn), count: fn.count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    lines.push(script.url || '(no url)')
    const width = Math.min(32, Math.max(...names.map((n) => n.name.length)))
    for (const n of names) lines.push(`  ${n.name.padEnd(width)}  ×${n.count}`)
  }
  if (hidden > 0 && !options.all) {
    lines.push(`… ${hidden} script${hidden === 1 ? '' : 's'} hidden (--all to show)`)
  }

  return { text: capLines(lines, options.maxLines), functions: total }
}
