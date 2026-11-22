import type { Box } from './types.js'

export const TOLERANCE_PX = 1
export const MIN_VISIBLE_PX = 2

export const right = (b: Box): number => b.x + b.width
export const bottom = (b: Box): number => b.y + b.height

export function intersection(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const w = Math.min(right(a), right(b)) - x
  const h = Math.min(bottom(a), bottom(b)) - y
  return w > 0 && h > 0 ? { x, y, width: w, height: h } : null
}

export function contains(outer: Box, inner: Box, tolerance = TOLERANCE_PX): boolean {
  return inner.x >= outer.x - tolerance && inner.y >= outer.y - tolerance
    && right(inner) <= right(outer) + tolerance && bottom(inner) <= bottom(outer) + tolerance
}

export function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, width: Math.max(right(a), right(b)) - x, height: Math.max(bottom(a), bottom(b)) - y }
}

export const hasArea = (b: Box): boolean => b.width >= MIN_VISIBLE_PX && b.height >= MIN_VISIBLE_PX

export function round(b: Box): Box {
  const r = (n: number): number => Math.round(n * 10) / 10
  return { x: r(b.x), y: r(b.y), width: r(b.width), height: r(b.height) }
}

export const describeBox = (b: Box): string => `${Math.round(b.width)}x${Math.round(b.height)} at ${Math.round(b.x)},${Math.round(b.y)}`
