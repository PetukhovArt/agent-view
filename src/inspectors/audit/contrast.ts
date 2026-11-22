import type { AuditNode, Rgba } from './types.js'

export const NORMAL_TEXT_RATIO = 4.5
export const LARGE_TEXT_RATIO = 3
const LARGE_TEXT_PX = 24
const LARGE_BOLD_TEXT_PX = 18.66
const BOLD_WEIGHT = 700
const OPAQUE = 0.99

type Rgb = { r: number; g: number; b: number }

const over = (base: Rgb, top: Rgba): Rgb => ({
  r: base.r * (1 - top.a) + top.r * top.a,
  g: base.g * (1 - top.a) + top.g * top.a,
  b: base.b * (1 - top.a) + top.b * top.a,
})

const mix = (from: Rgb, to: Rgb, amount: number): Rgb => ({
  r: from.r + (to.r - from.r) * amount,
  g: from.g + (to.g - from.g) * amount,
  b: from.b + (to.b - from.b) * amount,
})

function channel(v: number): number {
  const s = Math.min(Math.max(v, 0), 255) / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

const luminance = (c: Rgb): number => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

export const hex = (c: Rgb): string =>
  `#${[c.r, c.g, c.b].map(v => Math.round(Math.min(Math.max(v, 0), 255)).toString(16).padStart(2, '0')).join('')}`

export const isLargeText = (n: Pick<AuditNode, 'fontSize' | 'fontWeight'>): boolean =>
  n.fontSize >= LARGE_TEXT_PX || (n.fontSize >= LARGE_BOLD_TEXT_PX && n.fontWeight >= BOLD_WEIGHT)

export type ContrastReading = { ratio: number; text: Rgb; background: Rgb; large: boolean }

export function readContrast(nodes: readonly AuditNode[], index: number, canvas: Rgba): ContrastReading | null {
  const node = nodes[index]
  if (!node.color || node.color.a <= 0 || node.backgroundClipText) return null

  const chain: AuditNode[] = []
  for (let i = index; i >= 0; i = nodes[i].parent) chain.unshift(nodes[i])

  for (let i = chain.length - 1; i >= 0; i--) {
    const layer = chain[i]
    if (layer.backgroundClipText || layer.backgroundImage) return null
    if (layer.background && layer.background.a >= OPAQUE && layer.opacity >= OPAQUE) break
  }

  const resolve = (depth: number, base: Rgb, paintText: boolean): Rgb => {
    const layer = chain[depth]
    let inner = layer.background ? over(base, layer.background) : base
    if (depth === chain.length - 1) {
      if (paintText && node.color) inner = over(inner, node.color)
    } else {
      inner = resolve(depth + 1, inner, paintText)
    }
    return layer.opacity < 1 ? mix(base, inner, layer.opacity) : inner
  }

  const text = resolve(0, canvas, true)
  const background = resolve(0, canvas, false)
  return { ratio: contrastRatio(text, background), text, background, large: isLargeText(node) }
}
