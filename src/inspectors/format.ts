/** Output helpers every inspector prints with, so the tails and units read the same across commands. */

/** Keep the first `maxLines - 1` lines and say how many were cut. */
export function capLines(lines: string[], maxLines?: number): string {
  if (maxLines === undefined || lines.length <= maxLines) return lines.join('\n')
  return [...lines.slice(0, maxLines - 1), `… ${lines.length - (maxLines - 1)} more lines`].join('\n')
}

/** `512 B`, `12.3 KB`, `1.5 MB`; negatives keep their sign, for deltas. */
export function formatBytes(n: number): string {
  const abs = Math.abs(n)
  if (abs < 1024) return `${n} B`
  if (abs < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
