import type { AXNode, LayoutSnapshot, Rect } from '../../cdp/types.js'

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'tab',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'listbox', 'slider', 'spinbutton', 'treeitem',
])
/** Not interactive, but the decider must see why the form it just sent came back (a snackbar). */
const NOTICE_ROLES: ReadonlySet<string> = new Set(['alert', 'status'])
/** Rows text can be typed into. */
export const TEXT_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton'])
const VALUE_ROLES: ReadonlySet<string> = new Set([...TEXT_ROLES, 'slider'])
const STATE_PROPS = ['checked', 'expanded', 'selected', 'disabled'] as const
const MAX_ROWS = 150
const NAME_SEARCH_DEPTH = 5
export const PASSWORD_MASK = '••••'

export type Control = {
  backendDOMNodeId: number
  role: string
  name: string
  testid?: string
  value?: string
  states: string[]
  isPassword: boolean
}

/**
 * Interactive AX nodes whose box is non-empty and intersects the viewport, in AX-tree order,
 * then pointer-only `item` rows in layout order.
 */
export function extractControls(ax: AXNode[], layout: LayoutSnapshot, testIdAttributes: readonly string[]): Control[] {
  const byId = new Map(ax.map(n => [n.nodeId, n]))
  const childName = (node: AXNode, depth: number): string => {
    if (depth <= 0) return ''
    for (const id of node.childIds ?? []) {
      const child = byId.get(id)
      if (!child) continue
      const found = child.name?.value || childName(child, depth - 1)
      if (found) return found
    }
    return ''
  }

  const controls: Control[] = []
  for (const node of ax) {
    const role = node.role?.value ?? ''
    const id = node.backendDOMNodeId
    if (node.ignored || !(INTERACTIVE_ROLES.has(role) || NOTICE_ROLES.has(role)) || id === undefined) continue
    const box = layout.nodes.get(id)
    if (!box || !isOnScreen(box.rect, layout.viewport)) continue

    const name = node.name?.value || childName(node, NAME_SEARCH_DEPTH)
    // Empty alerts are standing slots (Vuetify's per-field `v-messages`), not news.
    if (NOTICE_ROLES.has(role) && !name) continue

    const testAttr = testIdAttributes.find(a => box.attributes[a])
    const rawValue = node.value?.value
    controls.push({
      backendDOMNodeId: id,
      role,
      name,
      testid: testAttr ? box.attributes[testAttr] : undefined,
      value: VALUE_ROLES.has(role) && (typeof rawValue === 'string' || typeof rawValue === 'number') && rawValue !== ''
        ? String(rawValue)
        : undefined,
      states: STATE_PROPS.filter(p => isStateOn(node, p)),
      isPassword: box.tag === 'input' && box.attributes['type']?.toLowerCase() === 'password',
    })
  }

  // A field wrapper (Vuetify `v-field`) often repeats its input's role — one control,
  // two rows. Names do not identify the pair: the wrapper's name turns into the typed
  // value. The AX tree does not nest them (the input is listed apart), so the box does:
  // the inner node carries the value, the wrapper around it goes. Fields only — a
  // parent treeitem boxes its children and is still a control of its own.
  const rectOf = (c: Control) => layout.nodes.get(c.backendDOMNodeId)!.rect
  const isWrapper = (outer: Control) => VALUE_ROLES.has(outer.role) && controls.some(inner =>
    inner !== outer && inner.role === outer.role && isLarger(rectOf(outer), rectOf(inner)) && isInside(rectOf(inner), rectOf(outer)))
  const axById = new Map(ax.map(n => [n.backendDOMNodeId, n]))
  const nameOf = (id: number, attributes: Record<string, string>): string => {
    const node = axById.get(id)
    return node?.name?.value || (node && childName(node, NAME_SEARCH_DEPTH)) || attributes['title'] || attributes['aria-label'] || ''
  }
  return [...controls.filter(c => !isWrapper(c)), ...pointerItems(controls, { layout, testIdAttributes, nameOf })]
}

/**
 * A `div` with a pointer handler and no interactive role (a widget-bar item) is invisible to
 * the AX filter above; a test id plus `cursor: pointer` marks it as meant to be pressed or dragged.
 * `cursor` is inherited, so a tagged node inside a control is that control, not an item.
 */
function pointerItems(
  controls: Control[],
  { layout, testIdAttributes, nameOf }: {
    layout: LayoutSnapshot
    testIdAttributes: readonly string[]
    nameOf: (id: number, attributes: Record<string, string>) => string
  },
): Control[] {
  const controlRects = controls.map(c => layout.nodes.get(c.backendDOMNodeId)!.rect)
  const items: Control[] = []
  for (const [id, box] of layout.nodes) {
    const testAttr = testIdAttributes.find(a => box.attributes[a])
    if (!testAttr || box.cursor !== 'pointer' || !isOnScreen(box.rect, layout.viewport)) continue
    if (controlRects.some(rect => isInside(box.rect, rect))) continue
    const name = nameOf(id, box.attributes)
    items.push({ backendDOMNodeId: id, role: 'item', name, testid: box.attributes[testAttr], states: [], isPassword: false })
  }
  return items
}

const isLarger = (a: Rect, b: Rect): boolean => a.width * a.height > b.width * b.height

function isInside(inner: Rect, outer: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
}

function isOnScreen(rect: Rect, viewport: { width: number; height: number }): boolean {
  const hasArea = rect.width > 0 && rect.height > 0
  const isIntersecting = rect.x < viewport.width && rect.y < viewport.height && rect.x + rect.width > 0 && rect.y + rect.height > 0
  return hasArea && isIntersecting
}

function isStateOn(node: AXNode, prop: string): boolean {
  const v = node.properties?.find(p => p.name === prop)?.value.value
  return v === true || v === 'true' || v === 'mixed'
}

/** Identity that survives a re-render: what the decider saw, not the DOM node. */
const fingerprint = (c: Control): string => `${c.role}|${c.name}|${c.testid ?? ''}`

export const describeControl = (c: Control): string => (c.name ? `${c.role} "${c.name}"` : c.role)

export function formatControlRow(c: Control, n: number): string {
  const parts = [`[${n}] ${describeControl(c)}${c.testid ? ` testid=${c.testid}` : ''}`]
  if (c.isPassword) parts.push(c.value === undefined ? 'empty' : PASSWORD_MASK)
  else if (c.value !== undefined) parts.push(JSON.stringify(c.value))
  parts.push(...c.states)
  return parts.join(' · ')
}

type TableHeader = { step: number; maxSteps: number; untilLabel: string }

export function formatControlTable(controls: Control[], header: TableHeader): string {
  const head = [`act step ${header.step}/${header.maxSteps}`, `${controls.length} controls`, `until ${header.untilLabel}`]
  const rows = controls.slice(0, MAX_ROWS).map((c, i) => formatControlRow(c, i + 1))
  const hidden = controls.length - rows.length
  if (hidden > 0) rows.push(`… ${hidden} more below — act scroll down`)
  return [head.join(' · '), ...rows].join('\n')
}

type RowResolution =
  | { control: Control }
  | { gone: Control }

/**
 * Stale guard: row n of the last printed table, located in a fresh snapshot.
 * Same node still a visible control → it; else the unique control with the same
 * fingerprint; else gone. Never a guess.
 */
export function resolveRow(last: Control, current: Control[]): RowResolution {
  const same = current.find(c => c.backendDOMNodeId === last.backendDOMNodeId)
  if (same) return { control: same }
  const key = fingerprint(last)
  const matches = current.filter(c => fingerprint(c) === key)
  return matches.length === 1 ? { control: matches[0] } : { gone: last }
}
