import {
  AUDIT_RULES, COARSE_MIN_TARGET_PX, DEFAULT_MIN_TARGET_PX,
  type AuditNode, type AuditOptions, type AuditRule, type AuditSnapshot, type Box, type Finding, type Severity,
} from './types.js'
import { TOLERANCE_PX, bottom, contains, describeBox, hasArea, intersection, right, round, union } from './geometry.js'
import { LARGE_TEXT_RATIO, NORMAL_TEXT_RATIO, hex, readContrast } from './contrast.js'

const MIN_OVERLAP_PX = 2
const MIN_OPACITY = 0.01
const MULTILINE_FACTOR = 2.2

type Hit = { node: number; finding: Finding }

const isHiddenByClip = (o: string): boolean => o === 'hidden' || o === 'clip'
const isScrollable = (o: string): boolean => o === 'auto' || o === 'scroll'
const clips = (o: string): boolean => o !== 'visible'

export type AuditContext = {
  nodes: readonly AuditNode[]
  viewport: AuditSnapshot['viewport']
  coarse: boolean
  canvas: AuditSnapshot['canvas']
  shown: boolean[]
}

export function buildContext(snapshot: AuditSnapshot): AuditContext {
  const { nodes } = snapshot
  const cumulative: number[] = []
  const shown: boolean[] = []
  nodes.forEach((n, i) => {
    cumulative[i] = (n.parent >= 0 ? cumulative[n.parent] : 1) * n.opacity
    shown[i] = n.visible && cumulative[i] > MIN_OPACITY
  })
  return { nodes, viewport: snapshot.viewport, coarse: snapshot.coarse, canvas: snapshot.canvas, shown }
}

function isAncestor(nodes: readonly AuditNode[], ancestor: number, of: number): boolean {
  for (let i = nodes[of].parent; i >= 0; i = nodes[i].parent) if (i === ancestor) return true
  return false
}

function clippingAncestors(nodes: readonly AuditNode[], index: number): number[] {
  const found: number[] = []
  if (nodes[index].position === 'fixed') return found
  let pending = nodes[index].position === 'absolute'
  for (let a = nodes[index].parent; a >= 0; a = nodes[a].parent) {
    const n = nodes[a]
    if (!pending || n.containingBlock) {
      pending = false
      if (n.clipBox) found.push(a)
    }
    if (n.position === 'absolute') pending = true
    if (n.position === 'fixed') break
  }
  return found
}

function clipAxes(rect: Box, clipper: AuditNode): Box | null {
  const clip = clipper.clipBox!
  const x0 = clips(clipper.overflowX) ? Math.max(rect.x, clip.x) : rect.x
  const x1 = clips(clipper.overflowX) ? Math.min(right(rect), right(clip)) : right(rect)
  const y0 = clips(clipper.overflowY) ? Math.max(rect.y, clip.y) : rect.y
  const y1 = clips(clipper.overflowY) ? Math.min(bottom(rect), bottom(clip)) : bottom(rect)
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null
}

function contentRect(n: AuditNode): Box {
  return n.interactive || n.replaced ? n.rect : n.textRect ?? n.rect
}

export function visibleRect(ctx: AuditContext, index: number): Box | null {
  const n = ctx.nodes[index]
  let rect: Box | null = contentRect(n)
  if (n.clipBox && !n.interactive && !n.replaced) rect = clipAxes(rect, n)
  for (const a of clippingAncestors(ctx.nodes, index)) {
    if (!rect) return null
    rect = clipAxes(rect, ctx.nodes[a])
  }
  return rect && hasArea(rect) ? rect : null
}

const hasContent = (n: AuditNode): boolean => n.ownText || n.interactive || n.replaced

function candidates(ctx: AuditContext): number[] {
  const out: number[] = []
  ctx.nodes.forEach((n, i) => {
    if (n.inRoot && n.target && hasContent(n) && ctx.shown[i] && hasArea(contentRect(n))) out.push(i)
  })
  return out
}

function make(ctx: AuditContext, node: number, rule: AuditRule, severity: Severity, rect: Box, detail: string): Hit {
  const n = ctx.nodes[node]
  return { node, finding: { rule, severity, target: n.target ?? { selector: n.tag }, rect: round(rect), detail } }
}

function offscreen(ctx: AuditContext): Hit[] {
  const { width: vw, height: vh } = ctx.viewport
  const hits: Hit[] = []
  for (const i of candidates(ctx)) {
    const rect = visibleRect(ctx, i)
    if (!rect) continue
    const overRight = right(rect) - vw
    const overLeft = -rect.x
    const straddlesX = (overRight > TOLERANCE_PX && rect.x < vw - TOLERANCE_PX) || (overLeft > TOLERANCE_PX && right(rect) > TOLERANCE_PX)
    if (straddlesX) {
      const side = overRight > TOLERANCE_PX && rect.x < vw - TOLERANCE_PX ? `right by ${Math.round(overRight)}` : `left by ${Math.round(overLeft)}`
      hits.push(make(ctx, i, 'offscreen', 'error', rect, `extends past the ${side} px of the ${vw} px wide viewport`))
      continue
    }
    if (!layeredVertically(ctx, i)) continue
    const overBottom = bottom(rect) - vh
    const overTop = -rect.y
    if (overBottom > TOLERANCE_PX && rect.y < vh - TOLERANCE_PX) {
      hits.push(make(ctx, i, 'offscreen', 'error', rect, `extends past the bottom by ${Math.round(overBottom)} px of the ${vh} px high viewport`))
    } else if (overTop > TOLERANCE_PX && bottom(rect) > TOLERANCE_PX) {
      hits.push(make(ctx, i, 'offscreen', 'error', rect, `extends past the top by ${Math.round(overTop)} px of the ${vh} px high viewport`))
    }
  }
  return hits
}

function layeredVertically(ctx: AuditContext, index: number): boolean {
  for (let i = index; i >= 0; i = ctx.nodes[i].parent) if (ctx.nodes[i].fixed || ctx.nodes[i].dialog) return true
  return false
}

function transformedBetween(nodes: readonly AuditNode[], index: number, clipper: number): boolean {
  for (let i = index; i >= 0 && i !== clipper; i = nodes[i].parent) if (nodes[i].transformed) return true
  return false
}

const isTextContent = (n: AuditNode): boolean => n.ownText && !n.interactive && !n.replaced

function scrolledIntoView(rect: Box, clipper: AuditNode): Box {
  const area = clipper.scrollArea
  const clip = clipper.clipBox
  if (!area || !clip) return rect
  let { x, y, width, height } = rect
  if (isScrollable(clipper.overflowX) && x >= area.x - TOLERANCE_PX && right(rect) <= right(area) + TOLERANCE_PX) {
    width = Math.min(width, clip.width)
    x = Math.max(clip.x, Math.min(x, right(clip) - width))
  }
  if (isScrollable(clipper.overflowY) && y >= area.y - TOLERANCE_PX && bottom(rect) <= bottom(area) + TOLERANCE_PX) {
    height = Math.min(height, clip.height)
    y = Math.max(clip.y, Math.min(y, bottom(clip) - height))
  }
  return { x, y, width, height }
}

function clipped(ctx: AuditContext): Hit[] {
  const hits: Hit[] = []
  for (const i of candidates(ctx)) {
    const n = ctx.nodes[i]
    if (!hasArea(n.rect)) continue
    const text = isTextContent(n)
    let rect = n.rect
    for (const a of clippingAncestors(ctx.nodes, i)) {
      const clipper = ctx.nodes[a]
      const clip = clipper.clipBox!
      rect = scrolledIntoView(rect, clipper)
      if (!intersection(rect, clip)) continue
      if (transformedBetween(ctx.nodes, i, a)) break
      const cutX = isHiddenByClip(clipper.overflowX) && !(clipper.ellipsis && text)
        && (rect.x < clip.x - TOLERANCE_PX || right(rect) > right(clip) + TOLERANCE_PX)
      const cutY = isHiddenByClip(clipper.overflowY) && !(clipper.lineClamp && text)
        && (rect.y < clip.y - TOLERANCE_PX || bottom(rect) > bottom(clip) + TOLERANCE_PX)
      if (!cutX && !cutY) continue
      const cut = cutX ? `${Math.round(Math.max(clip.x - rect.x, right(rect) - right(clip)))} px horizontally` : `${Math.round(Math.max(clip.y - rect.y, bottom(rect) - bottom(clip)))} px vertically`
      const by = clipper.target?.selector ?? clipper.tag
      hits.push(make(ctx, i, 'clipped', 'error', n.rect, `cut by ${cut} by ancestor ${by} (overflow: ${cutX ? clipper.overflowX : clipper.overflowY})`))
      break
    }
  }
  return hits
}

const TEXT_CLIP_TOLERANCE_PX = 3

function textClip(ctx: AuditContext): Hit[] {
  const hits: Hit[] = []
  for (const i of candidates(ctx)) {
    const n = ctx.nodes[i]
    const s = n.scroll
    if (!s || !n.ownText || !hasArea(n.rect)) continue
    const overX = s.width - s.clientWidth
    const overY = s.height - s.clientHeight
    const flagX = overX > TEXT_CLIP_TOLERANCE_PX && !isScrollable(n.overflowX) && !(n.ellipsis && isHiddenByClip(n.overflowX))
    const flagY = overY > TEXT_CLIP_TOLERANCE_PX && !isScrollable(n.overflowY) && !n.lineClamp
    if (flagX) hits.push(make(ctx, i, 'text-clip', 'error', n.rect, `text overflows its box horizontally: scrollWidth ${s.width} > clientWidth ${s.clientWidth}, no text-overflow: ellipsis`))
    else if (flagY) hits.push(make(ctx, i, 'text-clip', 'error', n.rect, `text overflows its box vertically: scrollHeight ${s.height} > clientHeight ${s.clientHeight}, no line clamp`))
  }
  return hits
}

type Item = { node: number; rect: Box }

const isWrappedText = (n: AuditNode, rect: Box): boolean => !n.interactive && !n.replaced && rect.height > n.fontSize * MULTILINE_FACTOR

function overlapItems(ctx: AuditContext): Item[] {
  const items: Item[] = []
  for (const i of candidates(ctx)) {
    const n = ctx.nodes[i]
    if (n.replaced && !n.interactive) continue
    const rect = visibleRect(ctx, i)
    if (rect && !isWrappedText(n, rect)) items.push({ node: i, rect })
  }
  return items.sort((a, b) => a.rect.x - b.rect.x)
}

function stackingContextOf(nodes: readonly AuditNode[], index: number): number {
  for (let i = nodes[index].parent; i >= 0; i = nodes[i].parent) if (nodes[i].stacking) return i
  return -1
}

function layerOf(nodes: readonly AuditNode[], index: number): number {
  for (let i = index; i >= 0; i = nodes[i].parent) if (nodes[i].layer) return i
  return -1
}

function describeTarget(ctx: AuditContext, index: number): string {
  const t = ctx.nodes[index].target
  if (!t) return ctx.nodes[index].tag
  return t.testid ?? (t.text ? `"${t.text}"` : t.name ? `"${t.name}"` : t.selector)
}

function overlap(ctx: AuditContext): Hit[] {
  const items = overlapItems(ctx)
  const contexts = new Map<number, number>()
  const layers = new Map<number, number>()
  const contextOf = (i: number): number => contexts.get(i) ?? contexts.set(i, stackingContextOf(ctx.nodes, i)).get(i)!
  const layerFor = (i: number): number => layers.get(i) ?? layers.set(i, layerOf(ctx.nodes, i)).get(i)!
  const hits: Hit[] = []
  for (let a = 0; a < items.length; a++) {
    for (let b = a + 1; b < items.length && items[b].rect.x < right(items[a].rect) - MIN_OVERLAP_PX; b++) {
      const first = items[a]
      const second = items[b]
      const common = intersection(first.rect, second.rect)
      if (!common || common.width <= MIN_OVERLAP_PX || common.height <= MIN_OVERLAP_PX) continue
      if (isAncestor(ctx.nodes, first.node, second.node) || isAncestor(ctx.nodes, second.node, first.node)) continue
      if (contains(first.rect, second.rect) || contains(second.rect, first.rect)) continue
      if (contextOf(first.node) !== contextOf(second.node) || layerFor(first.node) !== layerFor(second.node)) continue
      const [early, late] = first.node < second.node ? [first, second] : [second, first]
      hits.push(make(ctx, early.node, 'overlap', 'error', common, `intersects ${describeTarget(ctx, late.node)} (${describeBox(late.rect)}) by ${Math.round(common.width)}x${Math.round(common.height)} px`))
    }
  }
  return hits
}

function targetSize(ctx: AuditContext, minTarget: number | undefined): Hit[] {
  const min = minTarget ?? (ctx.coarse ? COARSE_MIN_TARGET_PX : DEFAULT_MIN_TARGET_PX)
  const severity: Severity = ctx.coarse ? 'error' : 'warn'
  const hits: Hit[] = []
  for (const i of candidates(ctx)) {
    const n = ctx.nodes[i]
    if (!n.interactive || n.disabled || !n.pointerEvents || (n.tag === 'a' && n.inline)) continue
    if (!visibleRect(ctx, i)) continue
    const rect = n.labelRect ? union(n.rect, n.labelRect) : n.rect
    if (rect.width >= min && rect.height >= min) continue
    hits.push(make(ctx, i, 'target-size', severity, rect, `${Math.round(rect.width)}x${Math.round(rect.height)} px, below ${min} px`))
  }
  return hits
}

function contrast(ctx: AuditContext): Hit[] {
  const hits: Hit[] = []
  for (const i of candidates(ctx)) {
    const n = ctx.nodes[i]
    if (!n.ownText || n.disabled || !visibleRect(ctx, i)) continue
    const reading = readContrast(ctx.nodes, i, ctx.canvas)
    if (!reading) continue
    const needed = reading.large ? LARGE_TEXT_RATIO : NORMAL_TEXT_RATIO
    if (reading.ratio >= needed) continue
    hits.push(make(ctx, i, 'contrast', 'warn', n.textRect ?? n.rect, `${reading.ratio.toFixed(2)}:1, below ${needed}:1 for ${reading.large ? 'large' : 'normal'} text (${hex(reading.text)} on ${hex(reading.background)})`))
  }
  return hits
}

export function dropNested(ctx: AuditContext, hits: Hit[]): Hit[] {
  const flagged = new Set(hits.map(h => h.node))
  return hits.filter(h => {
    for (let i = ctx.nodes[h.node].parent; i >= 0; i = ctx.nodes[i].parent) if (flagged.has(i)) return false
    return true
  })
}

const RULES: Record<AuditRule, (ctx: AuditContext, options: AuditOptions) => Hit[]> = {
  offscreen: ctx => dropNested(ctx, offscreen(ctx)),
  clipped: ctx => dropNested(ctx, clipped(ctx)),
  'text-clip': ctx => textClip(ctx),
  overlap: ctx => overlap(ctx),
  'target-size': (ctx, options) => targetSize(ctx, options.minTarget),
  contrast: ctx => contrast(ctx),
}

export function runRules(snapshot: AuditSnapshot, options: AuditOptions = {}): Finding[] {
  const ctx = buildContext(snapshot)
  const rules = options.rules ?? AUDIT_RULES
  return AUDIT_RULES.filter(rule => rules.includes(rule)).flatMap(rule => RULES[rule](ctx, options).map(h => h.finding))
}
