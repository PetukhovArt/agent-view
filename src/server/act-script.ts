import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, posix, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { CDPTimeoutError, withTimeout } from '../cdp/transport.js'
import { EvaluationError, MouseButton, type ClickOpts, type Modifier, type PageSession, type Point, type Rect } from '../cdp/types.js'
import { findByLocator, locatorFromArgs, testIdLocator, type Locator } from './locator.js'
import { AGENT_VIEW_DIR } from './port.js'

/**
 * How a replay finds a table row again: its test id, else role + name, `nth` (from 0) of several
 * visible controls sharing that test id or role + name (the × of every tab).
 */
export type RowTarget = { testid?: string; role: string; name: string; nth?: number }

/** Any element by test id or CSS: what is no table row (a canvas, a drop zone). */
export type ElementTarget = { testid: string } | { selector: string }

export type Target = RowTarget | ElementTarget

export const isRowTarget = (target: Target): target is RowTarget => 'role' in target

/** Click ops of the step protocol and the pointer each one sends. */
export const CLICKS = {
  click: {},
  dblclick: { clicks: 2 },
  rightclick: { button: MouseButton.Right },
} as const satisfies Record<string, ClickOpts>
export type ClickOp = keyof typeof CLICKS

export const isClickOp = (op: string): op is ClickOp => Object.keys(CLICKS).includes(op)

/** `at`: a point from the target's top-left corner, px, instead of its centre (a spot on a canvas). */
export type RecordedStep =
  | { op: ClickOp | 'type' | 'select'; target: Target; value?: string; isPassword: boolean; at?: Point; modifiers?: Modifier[] }
  /** `target`: the element under the wheel; absent = the viewport centre. */
  | { op: 'scroll'; direction: 'up' | 'down'; target?: Target }
  /** `to`: a row, any element, or absent = the viewport; `toAt` replaces the `edge` point. */
  /** `isHtml5`: a native drag-and-drop (draggable rows), not pointer events. */
  | { op: 'drag'; target: Target; at?: Point; to?: Target; edge: Edge; toAt?: Point; isHtml5?: boolean }
  /** A state no element shows (data loaded, an animation over): runs page JS, so `allowEval` only. */
  | { op: 'wait'; expr: string }

/** Exactly one is set; `expr` is a JS expression in the page. */
export type UntilArgs = { testid?: string; selector?: string; expr?: string }

/** What an until or a wait step waits for: a visible element, or a JS expression. */
export type Condition = Locator | { expr: string; label: string }

export const exprCondition = (expr: string): Condition => ({ expr, label: `expression ${JSON.stringify(expr)}` })

export const conditionOf = (until: UntilArgs, testIdAttribute: string | undefined): Condition | undefined =>
  (until.expr !== undefined ? exprCondition(until.expr) : locatorFromArgs({ ...until, testIdAttribute }))

/** A one-off check (not a poll) gives an expression's promise this long. */
export const GLANCE_MS = 500

/** A promise holds once it resolves, whatever its value (a `Promise<void>` ready hook); any other value while truthy. */
const settledExpression = (expr: string) =>
  `(async () => { const v = (${expr}\n); return typeof v?.then === 'function' ? (await v, true) : !!v })()`

/**
 * Undefined when `condition` holds now, else why not. An expression's promise gets `waitMs`; an
 * expression that throws or rejects does not hold. A dead socket is thrown.
 */
export async function unmet(conn: PageSession, condition: Condition, waitMs: number): Promise<string | undefined> {
  if (!('expr' in condition)) return 'error' in await findByLocator(conn, condition) ? 'not visible' : undefined
  try {
    const value = await withTimeout(conn.evaluate(settledExpression(condition.expr), { awaitPromise: true }), waitMs, 'expression')
    return value === true ? undefined : 'not true'
  } catch (err) {
    if (err instanceof CDPTimeoutError) return 'still pending'
    if (err instanceof EvaluationError) return `threw ${err.message.split('\n')[0]}`
    throw err
  }
}

export type ActScript = {
  until: UntilArgs
  steps: RecordedStep[]
  note?: string
  /** What each `${NAME}` stands for (`ROW`: tree id of the row); kept out of the index. */
  paramNotes?: Record<string, string>
  /** Where the recording began: hash route, else path + query. Informational; replay does not navigate. */
  start?: string
  /** Script replayed first unless its own until already holds (a login). */
  after?: string
  /** Seconds the until may take to show after the steps (a long import); default DEFAULT_UNTIL_TIMEOUT_S. */
  timeout?: number
}

export const DEFAULT_UNTIL_TIMEOUT_S = 15

/** One step of a Use Case: a step script, its parameter values, and a timeout overriding the step's. */
export type UseEntry = { step: string; params?: Record<string, string>; timeout?: number }

/** A user goal as an ordered list of step scripts; their `after` is not run ([ADR 0005]). */
export type UseCase = {
  until: UntilArgs
  use: UseEntry[]
  note?: string
  paramNotes?: Record<string, string>
  /** Fixtures (store-relative paths) to run before; replay names them, never runs them. */
  requires?: string[]
}

export type SavedScript = ActScript | UseCase

export const isUseCase = (script: SavedScript): script is UseCase => 'use' in script

/** How `script` runs the script `name`: as a use case step, as its `after`, or not at all. */
export const howNamed = (script: SavedScript, name: string): 'a step' | 'after' | undefined => (isUseCase(script)
  ? (script.use.some(e => e.step === name) ? 'a step' : undefined)
  : (script.after === name ? 'after' : undefined))
export const USE_CASE_SUFFIX = '-use-case'

const execFileAsync = promisify(execFile)
/** The old global pile: still read when a name is missing from the project store, never written. */
const LEGACY_DIR = join(AGENT_VIEW_DIR, 'scratch')
const FIXTURES_DIR = 'fixtures'
const REPLAY_HINT = 'Replay one with `agent-view act replay <name>`.'

export const isScriptName = (name: string | undefined): name is string => !!name && /^[\w-][\w.-]*$/.test(name)
/** A path inside the store under some `<section>/fixtures/`. */
export const isFixturePath = (path: string): boolean => {
  const segments = path.split(/[\\/]/)
  return !isAbsolute(path) && !segments.includes('..') && segments.slice(0, -1).includes(FIXTURES_DIR)
}
/** A store subdirectory (`auth`, `editor/canvas`): named segments, none of them `fixtures`. */
export const isSection = (section: string | undefined): section is string =>
  !!section && section.split('/').every(s => isScriptName(s) && s !== FIXTURES_DIR)

/** `${NAME}` in a saved string: an env var of that name, substituted at replay. */
const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g
const PARAM_ARG = /^([A-Z][A-Z0-9_]*)=(.+)$/s
/** Protocol words: never a parameter, so a value that happens to equal `click` stays an op. */
const FIXED_KEYS = new Set(['op', 'role', 'edge', 'direction', 'modifiers'])

/** Every string replay matches or types: test ids, names, typed text, the until. */
function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T
  if (Array.isArray(value)) return value.map(v => mapStrings(v, fn)) as T
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, FIXED_KEYS.has(k) ? v : mapStrings(v, fn)])) as T
}

/** A use case's own strings are its until and its entries' parameter values; step names stay as they are. */
const mapScript = <S extends SavedScript>(script: S, fn: (s: string) => string): S => (isUseCase(script)
  ? { ...script, until: mapStrings(script.until, fn), use: script.use.map(e => (e.params ? { ...e, params: mapStrings(e.params, fn) } : e)) }
  : { ...script, until: mapStrings(script.until, fn), steps: mapStrings(script.steps, fn) }) as S

/**
 * `--param NAME=value` at save: every occurrence of the value becomes `${NAME}`, longest value
 * first so one that contains another is not split. A value found nowhere is an error, not a no-op.
 */
export function markParams(script: ActScript, params: string[]): ActScript | { error: string } {
  const pairs = parsePairs('--param', params)
  if ('error' in pairs) return pairs
  let marked = script
  for (const [name, value] of pairs.sort((a, b) => b[1].length - a[1].length)) {
    let isFound = false
    marked = mapScript(marked, s => {
      if (!s.includes(value)) return s
      isFound = true
      return s.split(value).join(`\${${name}}`)
    })
    if (!isFound) return { error: `--param ${name}: "${value}" is in no step and not in the until` }
  }
  return marked
}

/** Parameter names a script needs, sorted. */
export function paramsOf(script: SavedScript): string[] {
  const names = new Set<string>()
  mapScript(script, s => {
    for (const m of s.matchAll(PLACEHOLDER)) names.add(m[1])
    return s
  })
  return [...names].sort()
}

function parsePairs(flag: string, args: string[]): [string, string][] | { error: string } {
  const pairs: [string, string][] = []
  for (const arg of args) {
    const match = PARAM_ARG.exec(arg)
    if (!match) return { error: `${flag} ${arg} — NAME=<value>, NAME of A-Z 0-9 _` }
    pairs.push([match[1], match[2]])
  }
  return pairs
}

export function parseParamNotes(args: string[] | undefined): Record<string, string> | { error: string } | undefined {
  if (!args) return undefined
  const pairs = parsePairs('--param-note', args)
  return 'error' in pairs ? pairs : Object.fromEntries(pairs)
}

/** The note is the goal on the script's index line, which an agent reads whole to pick one script. */
export const NOTE_MAX = 120
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/**
 * Why `script` may not be saved. A uuid differs between projects and machines, so a script holding
 * one fits only where it was recorded; `params` are the `--param NAME=value` args it was marked
 * from, their values no longer in its strings.
 */
export function refuseScript(script: SavedScript, params: string[] = []): string | undefined {
  const { note, paramNotes = {} } = script
  const isNoteUnfit = note !== undefined && (note.length > NOTE_MAX || /[\r\n]/.test(note))
  if (isNoteUnfit) return `--note: one sentence of at most ${NOTE_MAX} characters, what the script does; how it ends — this one has ${note.length}`
  const takes = paramsOf(script)
  const stray = Object.keys(paramNotes).filter(n => !takes.includes(n))
  if (stray.length) return `--param-note ${stray.join(', ')}: the script takes no such parameter${takes.length ? ` — it takes ${takes.join(', ')}` : ''}`
  const strings = [...params, note ?? '', ...Object.values(paramNotes)]
  mapScript(script, s => {
    strings.push(s)
    return s
  })
  const withUuid = strings.find(s => UUID.test(s))
  return withUuid && `"${withUuid}" holds a uuid, which differs between projects and machines — target by visible text or a path`
}

/** Placeholders replaced by `values`; call only once `paramsOf` is covered. */
export const fillParams = <S extends SavedScript>(script: S, values: Record<string, string>): S =>
  mapScript(script, s => s.replace(PLACEHOLDER, (m, name: string) => values[name] ?? m))

/**
 * `<main checkout>/<rel>/.agent-view/scripts`, `rel` being where the project sits in its
 * checkout: every git worktree of a project shares the main checkout's store, so a script
 * recorded on one branch is found on all. Outside git, the project dir itself.
 */
export async function scriptStore(projectDir: string): Promise<string> {
  const dir = await realpath(projectDir)
  const args = ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel']
  const root = await execFileAsync('git', args, { cwd: dir, windowsHide: true }).then(
    ({ stdout }) => {
      const [commonDir, toplevel] = stdout.trim().split(/\r?\n/)
      // A submodule's common dir sits in the superproject's .git/modules: it has no main checkout of its own.
      const main = basename(commonDir) === '.git' ? dirname(commonDir) : toplevel
      return join(main, relative(toplevel, dir))
    },
    () => dir,
  )
  return join(root, '.agent-view', 'scripts')
}

/** Where a script lies: `section` is its store subdirectory, '' for one in the store root (saved before sections). */
export type StoreEntry = { name: string; section: string; path: string }
export type LoadedScript = StoreEntry & { script: SavedScript }

const byPlace = (a: StoreEntry, b: StoreEntry) => (a.section === b.section ? (a.name < b.name ? -1 : 1) : a.section < b.section ? -1 : 1)
const readJson = (path: string): Promise<SavedScript | undefined> =>
  readFile(path, 'utf8').then(text => JSON.parse(text) as SavedScript).catch(() => undefined)

/** Every script file of the store, sections walked recursively; `fixtures/` holds no scripts. */
export async function scriptFiles(store: string): Promise<StoreEntry[]> {
  const files = await readdir(store, { recursive: true }).catch(() => [] as string[])
  return files
    .map(f => f.split(sep).join('/'))
    .filter(f => f.endsWith('.json') && !f.split('/').includes(FIXTURES_DIR))
    .map(f => ({ name: posix.basename(f, '.json'), section: posix.dirname(f) === '.' ? '' : posix.dirname(f), path: join(store, f) }))
    .sort(byPlace)
}

/** A script by its store-wide name, in any section; missing from the store, the old scratch pile. */
export async function findScript(store: string, name: string): Promise<LoadedScript | undefined> {
  if (!isScriptName(name)) return undefined
  const entry = (await scriptFiles(store)).find(e => e.name === name) ?? { name, section: '', path: join(LEGACY_DIR, `${name}.json`) }
  const script = await readJson(entry.path)
  return script && { ...entry, script }
}

export async function listScripts(store: string): Promise<LoadedScript[]> {
  const entries = await Promise.all((await scriptFiles(store)).map(async e => ({ ...e, script: await readJson(e.path) })))
  return entries.filter((e): e is LoadedScript => e.script !== undefined)
}

const INDEX_FILE = 'index.md'

/** Sections holding scripts, sorted; the store root ('') is none. */
export const sectionsOf = (entries: StoreEntry[]): string[] => [...new Set(entries.map(e => e.section).filter(Boolean))]

/** `entry` lies in `section` or below it: `editor` covers `editor/canvas`. */
export const isUnder = (entry: StoreEntry, section: string): boolean => entry.section === section || entry.section.startsWith(`${section}/`)

export const withoutPasswords = (steps: RecordedStep[]): RecordedStep[] =>
  steps.map(s => ('isPassword' in s && s.isPassword ? { ...s, value: undefined } : s))

/** Steps are stored by what identifies a control across runs, never by row number. Passwords are not stored. */
export async function writeScript({ store, name, section = '' }: { store: string; name: string; section?: string }, script: SavedScript): Promise<string> {
  const dir = join(store, section)
  await mkdir(dir, { recursive: true })
  const saved = isUseCase(script) ? script : { ...script, steps: withoutPasswords(script.steps) }
  const path = join(dir, `${name}.json`)
  await writeFile(path, JSON.stringify(saved, null, 1))
  await writeIndexes(store)
  return path
}

export async function removeScript(store: string, path: string): Promise<void> {
  await rm(path)
  await writeIndexes(store)
}

/**
 * The index.md of each section and of the store root; drops the one of a section left empty (its
 * scripts moved by hand or deleted) and any `INDEX.md` written before 0.21.
 */
async function writeIndexes(store: string): Promise<void> {
  const entries = await listScripts(store)
  const sections = sectionsOf(entries)
  // Removed first, not overwritten: on a case-insensitive disk a write to index.md keeps the old INDEX.md name.
  const indexes = (await readdir(store, { recursive: true })).map(f => f.split(sep).join('/'))
    .filter(f => posix.basename(f).toLowerCase() === INDEX_FILE)
  const stale = indexes.filter(f => posix.basename(f) !== INDEX_FILE || (posix.dirname(f) !== '.' && !sections.includes(posix.dirname(f))))
  await Promise.all(stale.map(f => rm(join(store, f))))
  await Promise.all(sections.map(s => writeFile(join(store, s, INDEX_FILE),
    `# ${s}: act scripts, generated by agent-view on every save and delete. ${REPLAY_HINT}\n\n${renderSection(entries.filter(e => e.section === s))}\n`)))
  await writeFile(join(store, INDEX_FILE),
    `# act scripts: generated by agent-view on every save and delete. ${REPLAY_HINT} A section's scripts are in its ${INDEX_FILE}, or \`agent-view act list <section>\`.\n\n${renderStore(entries)}\n`)
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The store root: one line per section, then any script still lying in the root. */
export function renderStore(entries: LoadedScript[]): string {
  const lines = sectionsOf(entries).map(s => {
    const inSection = entries.filter(e => e.section === s)
    const useCases = inSection.filter(e => isUseCase(e.script)).length
    return `- \`${s}/\` — ${plural(inSection.length - useCases, 'step')}${useCases ? `, ${plural(useCases, 'use case')}` : ''}`
  })
  const loose = entries.filter(e => !e.section)
  return [lines.join('\n'), loose.length && `In no section yet (move each into one):\n${renderSection(loose)}`].filter(Boolean).join('\n\n')
}

/** One section: its steps, then its use cases. */
export function renderSection(entries: LoadedScript[]): string {
  const steps = entries.filter(e => !isUseCase(e.script))
  const useCases = entries.filter(e => isUseCase(e.script))
  return [steps.length && `Steps:\n${renderScripts(steps)}`, useCases.length && `Use cases:\n${renderScripts(useCases)}`]
    .filter(Boolean).join('\n\n')
}

/** What picking a script needs, one line each; the until, the steps and the param notes are in its JSON. */
const renderScripts = (entries: { name: string; script: SavedScript }[]): string => entries.map(({ name, script: s }) => {
  const params = paramsOf(s)
  const fields = [
    params.length && `params ${params.join(' ')}`,
    !isUseCase(s) && s.after && `after ${s.after}`,
    isUseCase(s) && s.requires?.length && `requires ${s.requires.join(' ')}`,
  ]
  return [`- [${name}](${name}.json)${s.note ? ` — ${s.note}` : ''}`, ...fields].filter(Boolean).join(' · ')
}).join('\n')

export const EDGES = ['left', 'right', 'top', 'bottom', 'center'] as const
export type Edge = typeof EDGES[number]
/** Deepest a drop point sits inside an edge; split zones along a widget edge are ~60 px strips. */
const EDGE_INSET_PX = 20

export const isEdge = (value: string): value is Edge => (EDGES as readonly string[]).includes(value)

/** Drop point inside `box`, on its midline, inset from `edge` — a centre drop replaces instead of splitting. */
export function edgePoint(box: Rect, edge: Edge): Point {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const insetX = Math.min(EDGE_INSET_PX, box.width / 4)
  const insetY = Math.min(EDGE_INSET_PX, box.height / 4)
  if (edge === 'left') return { x: box.x + insetX, y: cy }
  if (edge === 'right') return { x: box.x + box.width - insetX, y: cy }
  if (edge === 'top') return { x: cx, y: box.y + insetY }
  if (edge === 'bottom') return { x: cx, y: box.y + box.height - insetY }
  return { x: cx, y: cy }
}

/** `at` from the box's top-left corner, else the box centre. */
export const pointIn = (box: Rect, at?: Point): Point =>
  (at ? { x: box.x + at.x, y: box.y + at.y } : { x: box.x + box.width / 2, y: box.y + box.height / 2 })

export const elementLocator = (target: ElementTarget, testIdAttribute: string | undefined): Locator =>
  ('testid' in target ? testIdLocator(target.testid, testIdAttribute) : { css: target.selector, label: `selector "${target.selector}"` })

/** A target on the CLI: row n of the last table, or any element; `at` = px from its top-left. */
export type CliTarget = ({ n: number } | { element: ElementTarget }) & { at?: Point }

/** `3` (a row), `testid=<id>` or `css=<selector>`, each optionally ending in `@x,y`. */
export function parseTarget(raw: string): CliTarget | undefined {
  const m = /^(.*?)(?:@(-?\d+),(-?\d+))?$/s.exec(raw.trim())!
  const at = m[2] === undefined ? undefined : { x: Number(m[2]), y: Number(m[3]) }
  const head = m[1]
  if (/^\d+$/.test(head)) return { n: Number(head), at }
  if (/^testid=./s.test(head)) return { element: { testid: head.slice('testid='.length) }, at }
  if (/^css=./s.test(head)) return { element: { selector: head.slice('css='.length) }, at }
  return undefined
}

/** Click op on a node, `modifiers` held: at `at` px from its top-left, else as a control (its centre). */
export async function clickNode(
  conn: PageSession,
  nodeId: number,
  op: ClickOp,
  { at, modifiers }: { at?: Point; modifiers?: Modifier[] } = {},
): Promise<void> {
  const opts = { ...CLICKS[op], modifiers }
  if (!at) return conn.clickByNodeId(nodeId, opts)
  const { x, y } = pointIn(await conn.getBoxRect(nodeId), at)
  await conn.clickAtPosition(x, y, opts)
}

/**
 * Drag from a node (its centre, or `at`) onto a drop node or the viewport: at `toAt`, else its `edge` point.
 * Pointer events, or a native drag-and-drop when `isHtml5`.
 */
export async function dragNode(
  conn: PageSession,
  nodeId: number,
  { at, dropId, toAt, edge, isHtml5 }: { at?: Point; dropId?: number; toAt?: Point; edge: Edge; isHtml5?: boolean },
): Promise<void> {
  // Source first: scrolling it into view may move the target, so the target is measured after.
  const from = at ? pointIn(await conn.getBoxRect(nodeId), at) : await conn.getBoxCenter(nodeId)
  const box = dropId === undefined ? await viewportBox(conn) : await conn.getBoxRect(dropId, { scrollIntoView: false })
  await conn.dragBetweenPositions(from, toAt ? pointIn(box, toAt) : edgePoint(box, edge), { mode: isHtml5 ? 'html5' : 'pointer' })
}

export const describeTarget = (target: Target): string => {
  if (!isRowTarget(target)) return 'testid' in target ? `testid=${target.testid}` : `css=${target.selector}`
  const named = target.name ? `${target.role} "${target.name}"` : target.role
  return `${named}${target.testid ? ` testid=${target.testid}` : ''}${target.nth ? ` #${target.nth + 1}` : ''}`
}

export const describeAt = (at: Point | undefined): string => (at ? ` @${at.x},${at.y}` : '')

/** `ctrl+click`: the op with the keys it held. */
export const describeOp = (op: string, modifiers: Modifier[] | undefined): string => [...(modifiers ?? []), op].join('+')

export async function viewportBox(conn: PageSession): Promise<Rect> {
  const { viewport } = await conn.getLayoutSnapshot()
  return { x: 0, y: 0, ...viewport }
}
