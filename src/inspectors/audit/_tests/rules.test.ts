import { describe, expect, it } from 'vitest'
import { runRules } from '../rules.js'
import { summarize, formatAudit, hasErrors } from '../index.js'
import type { AuditNode, AuditSnapshot, Box } from '../types.js'

const box = (x: number, y: number, width: number, height: number): Box => ({ x, y, width, height })

const node = (over: Partial<AuditNode> & { rect: Box }): AuditNode => ({
  parent: 0,
  tag: 'p',
  textRect: null,
  ownText: true,
  interactive: false,
  replaced: false,
  disabled: false,
  visible: true,
  opacity: 1,
  position: 'static',
  overflowX: 'visible',
  overflowY: 'visible',
  clipBox: null,
  scrollArea: null,
  ellipsis: false,
  lineClamp: false,
  scroll: null,
  stacking: false,
  containingBlock: false,
  transformed: false,
  layer: false,
  dialog: false,
  fixed: false,
  inline: false,
  pointerEvents: true,
  labelRect: null,
  color: { r: 0, g: 0, b: 0, a: 1 },
  background: null,
  backgroundImage: false,
  backgroundClipText: false,
  fontSize: 14,
  fontWeight: 400,
  inRoot: true,
  target: { testid: 'n', selector: 'p' },
  ...over,
})

const html = (): AuditNode => node({ parent: -1, tag: 'html', rect: box(0, 0, 800, 600), ownText: false, target: null, stacking: true })

const snapshot = (...nodes: AuditNode[]): AuditSnapshot => ({
  viewport: { width: 800, height: 600 },
  coarse: false,
  canvas: { r: 255, g: 255, b: 255, a: 1 },
  nodes: [html(), ...nodes],
  truncated: false,
})

const named = (id: string, over: Partial<AuditNode> & { rect: Box }): AuditNode => node({ ...over, target: { testid: id, selector: id } })

const ids = (s: AuditSnapshot, rule: string): string[] =>
  runRules(s).filter(f => f.rule === rule).map(f => f.target.testid ?? f.target.selector)

const grey = (v: number): { r: number; g: number; b: number; a: number } => ({ r: v, g: v, b: v, a: 1 })

describe('offscreen', () => {
  it('flags an element that crosses the right edge and not one parked fully outside', () => {
    const s = snapshot(named('cross', { rect: box(720, 10, 136, 16) }), named('parked', { rect: box(900, 10, 100, 16) }))
    expect(ids(s, 'offscreen')).toEqual(['cross'])
  })

  it('flags text in a fixed layer that crosses the bottom edge, not a flowing element', () => {
    const dialog = named('dlg', { rect: box(400, 500, 300, 100), fixed: true, dialog: true, layer: true, ownText: false })
    const inside = named('inside', { parent: 1, rect: box(410, 590, 250, 16) })
    const flowing = named('flow', { rect: box(10, 590, 100, 30) })
    expect(ids(snapshot(dialog, inside, flowing), 'offscreen')).toEqual(['inside'])
  })

  it('ignores invisible and transparent elements', () => {
    const s = snapshot(named('hidden', { rect: box(720, 10, 136, 16), visible: false }), named('faded', { rect: box(720, 40, 136, 16), opacity: 0 }))
    expect(ids(s, 'offscreen')).toEqual([])
  })
})

describe('clipped', () => {
  const clipper = (over: Partial<AuditNode> = {}): AuditNode => node({
    rect: box(20, 60, 120, 36), clipBox: box(20, 60, 120, 36), overflowX: 'hidden', overflowY: 'hidden', ownText: false, target: { selector: 'div' }, ...over,
  })

  it('flags content cut by an overflow hidden ancestor', () => {
    const s = snapshot(clipper(), named('btn', { parent: 1, tag: 'button', interactive: true, rect: box(20, 60, 170, 30) }))
    expect(ids(s, 'clipped')).toEqual(['btn'])
  })

  it('does not flag a scroll container, an ellipsis box or a transformed slide', () => {
    const scroller = snapshot(clipper({ overflowX: 'auto', overflowY: 'auto' }), named('t', { parent: 1, rect: box(20, 60, 170, 16) }))
    expect(ids(scroller, 'clipped')).toEqual([])
    const ellipsis = snapshot(clipper({ ellipsis: true, overflowY: 'visible' }), named('t', { parent: 1, rect: box(20, 60, 170, 16) }))
    expect(ids(ellipsis, 'clipped')).toEqual([])
    const slide = snapshot(clipper(), named('mid', { parent: 1, transformed: true, ownText: false, rect: box(-40, 60, 360, 20) }), named('t', { parent: 2, rect: box(-40, 60, 120, 16) }))
    expect(ids(slide, 'clipped')).toEqual([])
  })

  it('flags an icon or a control cut by an ellipsis box, and not the text it truncates', () => {
    const ellipsisButton = named('ellipsis-btn', {
      tag: 'button', interactive: true, ownText: false, rect: box(20, 60, 8, 18), clipBox: box(21, 60, 6, 18),
      overflowX: 'hidden', overflowY: 'hidden', ellipsis: true,
    })
    const icon = named('icon', { parent: 1, tag: 'svg', replaced: true, ownText: false, rect: box(17, 62, 14, 14) })
    expect(ids(snapshot(ellipsisButton, icon), 'clipped')).toEqual(['icon'])
    const text = named('text', { parent: 1, rect: box(17, 62, 40, 14) })
    expect(ids(snapshot(ellipsisButton, text), 'clipped')).toEqual([])
    const control = named('control', { parent: 1, tag: 'button', interactive: true, rect: box(17, 62, 40, 14) })
    expect(ids(snapshot(ellipsisButton, control), 'clipped')).toEqual(['control'])
  })

  describe('inside a scroll container', () => {
    const panel = (): AuditNode => clipper()
    const scroller = (scrollArea: Box): AuditNode => clipper({
      parent: 1, overflowX: 'auto', overflowY: 'visible', clipBox: box(20, 60, 120, 36), scrollArea, target: { selector: 'scroller' },
    })

    it('does not flag a column past the scroller edge but inside its scrollable area, on either side', () => {
      const right = snapshot(panel(), scroller(box(20, 60, 260, 36)), named('col', { parent: 2, rect: box(120, 60, 60, 20) }))
      expect(ids(right, 'clipped')).toEqual([])
      const left = snapshot(panel(), scroller(box(-80, 60, 260, 36)), named('col', { parent: 2, rect: box(-10, 60, 50, 20) }))
      expect(ids(left, 'clipped')).toEqual([])
    })

    it('still flags content past the end of the scrollable area that the hidden panel cuts', () => {
      const s = snapshot(panel(), scroller(box(20, 60, 140, 36)), named('col', { parent: 2, rect: box(130, 60, 50, 20) }))
      expect(ids(s, 'clipped')).toEqual(['col'])
    })

    it('still flags a node cut by a hidden box inside the scroller', () => {
      const inner = clipper({ parent: 2, clipBox: box(20, 60, 60, 36), rect: box(20, 60, 60, 36), target: { selector: 'inner' } })
      const s = snapshot(panel(), scroller(box(20, 60, 300, 36)), inner, named('btn', { parent: 3, tag: 'button', interactive: true, rect: box(20, 60, 100, 30) }))
      expect(ids(s, 'clipped')).toEqual(['btn'])
    })
  })
})

describe('text-clip', () => {
  it('flags text wider than its box without ellipsis', () => {
    const s = snapshot(named('wide', { rect: box(20, 110, 80, 16), scroll: { width: 139, clientWidth: 80, height: 16, clientHeight: 16 } }))
    expect(ids(s, 'text-clip')).toEqual(['wide'])
  })

  it('accepts ellipsis, line clamp, scrollers and sub-pixel growth', () => {
    const wide = { width: 139, clientWidth: 80, height: 16, clientHeight: 16 }
    const tall = { width: 80, clientWidth: 80, height: 48, clientHeight: 20 }
    const s = snapshot(
      named('ellipsis', { rect: box(0, 0, 80, 16), scroll: wide, ellipsis: true, overflowX: 'hidden' }),
      named('clamp', { rect: box(0, 20, 80, 20), scroll: tall, lineClamp: true, overflowY: 'hidden' }),
      named('scroll', { rect: box(0, 40, 80, 20), scroll: tall, overflowY: 'auto' }),
      named('glyph', { rect: box(0, 60, 32, 16), scroll: { width: 32, clientWidth: 32, height: 18, clientHeight: 16 } }),
    )
    expect(ids(s, 'text-clip')).toEqual([])
  })
})

describe('overlap', () => {
  it('flags two text boxes that intersect', () => {
    const s = snapshot(named('a', { rect: box(20, 170, 74, 16), textRect: box(20, 170, 74, 16) }), named('b', { rect: box(60, 176, 115, 16), textRect: box(60, 176, 115, 16) }))
    expect(ids(s, 'overlap')).toEqual(['a'])
  })

  it('does not flag neighbours, nesting, badges or a layer over content', () => {
    const adjacent = snapshot(named('a', { rect: box(0, 0, 40, 16) }), named('b', { rect: box(40, 0, 40, 16) }))
    expect(ids(adjacent, 'overlap')).toEqual([])
    const nested = snapshot(named('outer', { rect: box(0, 0, 100, 40) }), named('inner', { parent: 1, rect: box(10, 10, 60, 16) }))
    expect(ids(nested, 'overlap')).toEqual([])
    const badge = snapshot(named('btn', { tag: 'button', interactive: true, rect: box(0, 0, 120, 30) }), named('count', { rect: box(70, 8, 10, 12) }))
    expect(ids(badge, 'overlap')).toEqual([])
    const popover = snapshot(named('under', { rect: box(0, 0, 100, 16) }), named('menu', { rect: box(20, 4, 60, 16), layer: true, position: 'absolute' }))
    expect(ids(popover, 'overlap')).toEqual([])
  })

  it('skips wrapped paragraphs whose union box is not the painted text', () => {
    const s = snapshot(named('para', { rect: box(0, 0, 300, 90), textRect: box(0, 0, 300, 90) }), named('bold', { rect: box(100, 20, 60, 16), textRect: box(100, 20, 60, 16) }))
    expect(ids(s, 'overlap')).toEqual([])
  })
})

describe('target-size', () => {
  const small = (over: Partial<AuditNode> = {}): AuditNode => named('s', { tag: 'button', interactive: true, ownText: false, rect: box(20, 290, 16, 16), ...over })

  it('warns under 24px with a fine pointer and errors under 44px with a coarse one', () => {
    expect(runRules(snapshot(small())).map(f => f.severity)).toEqual(['warn'])
    expect(runRules({ ...snapshot(small()), coarse: true }).map(f => f.severity)).toEqual(['error'])
  })

  it('skips disabled, inline links, large controls and a control with a big label', () => {
    expect(ids(snapshot(small({ disabled: true })), 'target-size')).toEqual([])
    expect(ids(snapshot(small({ tag: 'a', inline: true })), 'target-size')).toEqual([])
    expect(ids(snapshot(small({ rect: box(0, 0, 60, 48) })), 'target-size')).toEqual([])
    expect(ids(snapshot(small({ tag: 'input', labelRect: box(0, 0, 140, 32) })), 'target-size')).toEqual([])
  })
})

describe('contrast', () => {
  it('flags low contrast and faded text, passes readable, large and gradient text', () => {
    const s = snapshot(
      named('low', { rect: box(0, 0, 100, 16), color: grey(153) }),
      named('ok', { rect: box(0, 20, 100, 16), color: grey(51) }),
      named('large', { rect: box(0, 40, 100, 32), color: grey(119), fontSize: 28 }),
      named('gradient', { rect: box(0, 80, 100, 16), color: grey(187), backgroundImage: true }),
      named('faded', { rect: box(0, 100, 100, 16), opacity: 0.4 }),
      named('off', { rect: box(0, 120, 100, 16), color: grey(170), disabled: true }),
    )
    expect(ids(s, 'contrast')).toEqual(['low', 'faded'])
  })
})

describe('output', () => {
  it('counts severities, prints one line per finding and reports errors for the exit code', () => {
    const findings = runRules(snapshot(
      named('cross', { rect: box(720, 10, 136, 16) }),
      named('tiny', { tag: 'button', interactive: true, ownText: false, rect: box(20, 290, 16, 16) }),
    ))
    const result = summarize(findings, { viewport: { width: 800, height: 600 }, coarsePointer: false, scanned: 3, truncated: false })
    expect(result.counts).toEqual({ error: 1, warn: 1 })
    expect(hasErrors(result)).toBe(true)
    const text = formatAudit(result)
    expect(text).toContain('audit: 1 error, 1 warning, 800x600 viewport, 3 elements')
    expect(text.split('\n')).toHaveLength(3)
  })
})
