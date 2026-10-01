import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { MODIFIERS, type Modifier } from '../cdp/types.js'
import type { ServerResponse } from '../types.js'
import {
  USE_CASE_SUFFIX,
  findScript,
  isFixturePath,
  isScriptName,
  isSection,
  isUnder,
  isUseCase,
  listScripts,
  paramsOf,
  parseParamNotes,
  refuseScript,
  removeScript,
  renderSection,
  renderStore,
  scriptFiles,
  scriptStore,
  sectionsOf,
  writeScript,
  type UntilArgs,
  type UseCase,
  type UseEntry,
} from './act-script.js'

/** `act` commands on the Script Store alone: no app, no Act Session ([ADR 0005](../../docs/adr/0005-script-store-sections-and-use-cases.md)). */

export const str = (args: Record<string, unknown>, key: string): string | undefined =>
  typeof args[key] === 'string' ? args[key] as string : undefined
/** A repeatable flag; none given is undefined, so `act save` keeps the `--param`s of `act start`. */
export const strs = (args: Record<string, unknown>, key: string): string[] | undefined => {
  const values = Array.isArray(args[key]) ? (args[key] as unknown[]).filter(v => typeof v === 'string') : []
  return values.length ? values : undefined
}
export const cwdOf = (args: Record<string, unknown>): string => str(args, 'cwd') ?? process.cwd()
/** `--modifiers ctrl,shift` of `click` and the act click ops. */
export function modifiersOf(args: Record<string, unknown>): Modifier[] | { error: string } | undefined {
  const raw = str(args, 'modifiers')
  if (raw === undefined) return undefined
  const keys = raw.split(',').map(k => k.trim())
  return keys.every((k): k is Modifier => (MODIFIERS as readonly string[]).includes(k))
    ? keys
    : { error: `--modifiers ${raw} — comma-separated ${MODIFIERS.join('|')}` }
}

const SECTION_HINT = '--in <section>: the product area it belongs to (auth, libraries, editor/canvas), integration for a use case crossing areas'

/** `act list [section]`: a section lists the ones below it too (`editor` → `editor/canvas`). */
export async function listSaved(args: Record<string, unknown>): Promise<ServerResponse> {
  const store = await scriptStore(cwdOf(args))
  const entries = await listScripts(store)
  if (entries.length === 0) return { ok: true, data: `No saved scripts in ${store} — record one with act start … --save <name> --in <section>` }
  const section = str(args, 'section')
  if (section === undefined) {
    return { ok: true, data: `${store} · replay: agent-view act replay <name> · one section: act list <section>\n${renderStore(entries)}` }
  }
  const inSection = entries.filter(e => isUnder(e, section))
  if (inSection.length === 0) {
    const sections = sectionsOf(entries)
    return { ok: false, error: `No section "${section}" in ${store}${sections.length ? ` — sections: ${sections.join(', ')}` : ''}` }
  }
  const sections = sectionsOf(inSection)
  const parts = sections.map(s => {
    const body = renderSection(inSection.filter(e => e.section === s))
    return sections.length > 1 ? `${s}/\n${body}` : body
  })
  return { ok: true, data: `${join(store, section)} · replay: agent-view act replay <name>\n${parts.join('\n\n')}` }
}

/** `act delete <name>`: refused while a use case lists it as a step or a step names it as `after`. */
export async function deleteScript(args: Record<string, unknown>): Promise<ServerResponse> {
  const name = str(args, 'name')
  const store = await scriptStore(cwdOf(args))
  const entries = await listScripts(store)
  const target = entries.find(e => e.name === name)
  if (!target) return { ok: false, error: `act delete ${name ?? '<name>'} — no such script in ${store}` }
  const users = entries.flatMap(({ name: user, script }) => {
    if (isUseCase(script)) return script.use.some(e => e.step === name) ? [`${user} (a step)`] : []
    return script.after === name ? [`${user} (after)`] : []
  })
  if (users.length) return { ok: false, error: `act delete ${name} — still named by ${users.join(', ')}: delete or re-save them first` }
  await removeScript(store, target.path)
  return { ok: true, data: `Deleted ${target.path}` }
}

/** Names are store-wide: one saved into a second section would make two scripts answer to it. */
async function sectionClash(store: string, name: string, section: string): Promise<ServerResponse | undefined> {
  const other = (await scriptFiles(store)).find(e => e.name === name && e.section !== section)
  if (!other) return undefined
  const where = other.section ? `--in ${other.section}, or move or delete ${other.path}` : `a section: move or delete ${other.path} first`
  return { ok: false, error: `"${name}" already lies in ${other.section || 'the store root'} — save it into ${where}` }
}

/** Why a recording cannot be saved as step `name` into `section`; checked at `act start --save` too, before the run. */
export async function refuseStepSave(store: string, name: string | undefined, section: string | undefined): Promise<ServerResponse | undefined> {
  if (!isScriptName(name)) return { ok: false, error: 'act save <name> — letters, digits, . _ - only' }
  if (name.endsWith(USE_CASE_SUFFIX)) return { ok: false, error: `act save ${name} — a recording is a step, its name does not end in ${USE_CASE_SUFFIX}` }
  if (!isSection(section)) return { ok: false, error: `act save ${name} ${SECTION_HINT}` }
  return sectionClash(store, name, section)
}

/** `tree-row-select ROW=library/A B timeout=120`: a value runs to the next ` KEY=`, so it may hold spaces. */
function parseUseEntry(line: string): UseEntry | { error: string } {
  const [step, ...pairs] = line.trim().split(/\s+(?=[A-Za-z_][A-Za-z0-9_]*=)/)
  if (!isScriptName(step)) return { error: `"${line}" — each step is "<step> [NAME=value …] [timeout=<seconds>]"` }
  const entry: UseEntry = { step }
  for (const pair of pairs) {
    const key = pair.slice(0, pair.indexOf('='))
    const value = pair.slice(key.length + 1)
    if (key === 'timeout') {
      if (!(Number(value) > 0)) return { error: `"${line}": timeout=<seconds>, a positive number` }
      entry.timeout = Number(value)
    } else if (/^[A-Z][A-Z0-9_]*$/.test(key) && value) {
      entry.params = { ...entry.params, [key]: value }
    } else {
      return { error: `"${line}": ${pair} — a parameter is NAME=<non-empty value>, NAME of A-Z 0-9 _; else timeout=<seconds>` }
    }
  }
  return entry
}

/**
 * `act save-use-case`: every step must be saved already and every parameter it takes bound (to a
 * value, or to `${NAME}` the use case takes from env); a fixture must be a file under `<section>/fixtures/`.
 */
export async function saveUseCase(args: Record<string, unknown>): Promise<ServerResponse> {
  const usage = `act save-use-case <name>${USE_CASE_SUFFIX} --in <section> --until-testid <id> | --until-selector <css> "<step> [NAME=value …] [timeout=<s>]" …`
  const name = str(args, 'name')
  const section = str(args, 'in')
  const until: UntilArgs = { testid: str(args, 'untilTestid'), selector: str(args, 'untilSelector') }
  const lines = strs(args, 'steps') ?? []
  if (!isScriptName(name) || !name.endsWith(USE_CASE_SUFFIX)) return { ok: false, error: `${usage} — the name ends in ${USE_CASE_SUFFIX}` }
  if (!isSection(section)) return { ok: false, error: `${usage} — ${SECTION_HINT}` }
  if ((until.testid === undefined) === (until.selector === undefined)) return { ok: false, error: `${usage} — exactly one until` }
  if (lines.length === 0) return { ok: false, error: `${usage} — at least one step` }
  const store = await scriptStore(cwdOf(args))
  const use: UseEntry[] = []
  for (const line of lines) {
    const entry = parseUseEntry(line)
    if ('error' in entry) return { ok: false, error: entry.error }
    const found = await findScript(store, entry.step)
    if (!found) return { ok: false, error: `No saved step "${entry.step}" — record it with act start … --save ${entry.step} --in <section>` }
    if (isUseCase(found.script)) return { ok: false, error: `"${entry.step}" is a use case — list its steps instead` }
    const takes = paramsOf(found.script)
    const given = Object.keys(entry.params ?? {})
    const unbound = takes.filter(p => !given.includes(p))
    if (unbound.length) return { ok: false, error: `"${entry.step}" needs ${unbound.join(', ')} — "${entry.step} ${unbound.map(p => `${p}=…`).join(' ')}"` }
    const unknown = given.filter(p => !takes.includes(p))
    if (unknown.length) return { ok: false, error: `"${entry.step}" takes no ${unknown.join(', ')}${takes.length ? ` — it takes ${takes.join(', ')}` : ''}` }
    use.push(entry)
  }
  const requires = strs(args, 'requires') ?? []
  for (const path of requires) {
    if (!isFixturePath(path)) return { ok: false, error: `--requires ${path} — a file under <section>/fixtures/ in the store` }
    if (!await stat(join(store, path)).then(s => s.isFile(), () => false)) return { ok: false, error: `--requires ${path}: no such file in ${store}` }
  }
  const paramNotes = parseParamNotes(strs(args, 'paramNotes'))
  if (paramNotes && 'error' in paramNotes) return { ok: false, error: paramNotes.error }
  const clash = await sectionClash(store, name, section)
  if (clash) return clash
  const script: UseCase = { until, use, note: str(args, 'note'), paramNotes, requires: requires.length ? requires : undefined }
  const refused = refuseScript(script)
  if (refused) return { ok: false, error: refused }
  const path = await writeScript({ store, name, section }, script)
  return { ok: true, data: `${path} · replay: agent-view act replay ${name}` }
}
