import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { scriptStore, writeScript } from './act-script.js'
import { saveUseCase } from './act-store.js'

const UUID = '7a1e0b52-1111-4c2a-9a01-000000000001'

describe('saveUseCase', () => {
  let cwd: string
  let store: string

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'av-store-'))
    store = await scriptStore(cwd)
    await writeScript({ store, name: 'tree-row-select', section: 'tree' }, {
      until: { selector: '[data-testid="${ROW}"][aria-selected]' },
      steps: [{ op: 'click', target: { testid: '${ROW}', role: 'treeitem', name: '${ROW_LABEL}' }, isPassword: false }],
      note: 'Выделяет строку дерева; строка выделена',
      paramNotes: { ROW: 'tree id строки', ROW_LABEL: 'её имя в дереве' },
      start: '#/editor',
      after: 'scene-open',
      timeout: 30,
    })
    mkdirSync(join(store, 'tree', 'fixtures'))
    writeFileSync(join(store, 'tree', 'fixtures', 'demo.sh'), '')
  })

  const save = (args: Record<string, unknown>) => saveUseCase({
    cwd, name: 'pick-use-case', in: 'tree', untilTestid: 'done', steps: ['tree-row-select ROW=library/A ROW_LABEL=${LABEL}'], ...args,
  })

  it('indexes each script as one line: link, goal, params, after, requires; until, steps and param notes stay in the JSON', async () => {
    await save({ note: 'FEA-10 TC-01: выделяет строку; строка выделена', paramNotes: ['LABEL=имя строки'], requires: ['tree/fixtures/demo.sh'] })

    expect(readFileSync(join(store, 'tree', 'index.md'), 'utf8')).toContain([
      'Steps:',
      '- [tree-row-select](tree-row-select.json) — Выделяет строку дерева; строка выделена · params ROW ROW_LABEL · after scene-open',
      '',
      'Use cases:',
      '- [pick-use-case](pick-use-case.json) — FEA-10 TC-01: выделяет строку; строка выделена · params LABEL · requires tree/fixtures/demo.sh',
    ].join('\n'))
    expect(JSON.parse(readFileSync(join(store, 'tree', 'pick-use-case.json'), 'utf8'))).toMatchObject({ paramNotes: { LABEL: 'имя строки' } })
  })

  it('refuses a uuid in a parameter value: it differs between projects and machines', async () => {
    const saved = await save({ steps: [`tree-row-select ROW=scene-component:${UUID} ROW_LABEL=A`] })

    expect(saved).toMatchObject({ ok: false, error: expect.stringContaining('uuid') })
  })

  it('refuses a note longer than one short sentence', async () => {
    const saved = await save({ note: 'а'.repeat(121) })

    expect(saved).toMatchObject({ ok: false, error: expect.stringContaining('120') })
  })

  it('refuses a param note for a parameter the use case does not take', async () => {
    const saved = await save({ paramNotes: ['ROW=tree id'] })

    expect(saved).toEqual({ ok: false, error: '--param-note ROW: the script takes no such parameter — it takes LABEL' })
  })
})
