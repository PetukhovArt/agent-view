import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EvaluationError, type PageSession } from '../cdp/types.js'
import { edgePoint, exprCondition, markParams, paramsOf, parseTarget, scriptStore, unmet } from './act-script.js'

describe('unmet', () => {
  /** Runs the expression the way Runtime.evaluate does, in this realm: a promise is awaited only with awaitPromise. */
  const page = {
    evaluate: async (expression: string, opts?: { awaitPromise?: boolean }) => {
      try {
        const value: unknown = (0, eval)(expression)
        return opts?.awaitPromise ? await value : value
      } catch (err) {
        throw new EvaluationError(String(err))
      }
    },
  } as unknown as PageSession

  it.each([
    ['a resolved promise of nothing (a ready hook) holds', 'Promise.resolve()', undefined],
    ['a truthy value holds', '[1].length', undefined],
    ['a falsy value does not', '[].length', 'not true'],
    ['a promise still pending does not', 'new Promise(() => {})', 'still pending'],
    ['an expression that throws does not, naming the error', 'notDefinedAnywhere.loaded', 'threw ReferenceError: notDefinedAnywhere is not defined'],
  ])('%s', async (_, expr, reason) => {
    expect(await unmet(page, exprCondition(expr), 50)).toBe(reason)
  })
})

describe('parseTarget', () => {
  it('keeps a scene object name whole, `@` and all: a scene target takes no @x,y', () => {
    expect(parseTarget('scene=Tower@12,4')).toEqual({ scene: 'Tower@12,4' })
  })
})

describe('edgePoint', () => {
  it('drops inside the right edge strip, not the replace-zone centre', () => {
    expect(edgePoint({ x: 56, y: 30, width: 1496, height: 850 }, 'right')).toEqual({ x: 1532, y: 455 })
  })

  it('shrinks the inset on a box narrower than 80 px', () => {
    expect(edgePoint({ x: 0, y: 0, width: 20, height: 100 }, 'left')).toEqual({ x: 5, y: 50 })
  })
})

describe('scriptStore', () => {
  const tmp = () => realpathSync.native(mkdtempSync(join(tmpdir(), 'av-store-')))
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })

  it('puts a worktree project in the main checkout, keeping its subdirectory', async () => {
    const main = tmp()
    mkdirSync(join(main, 'apps', 'web'), { recursive: true })
    git(main, 'init', '-q')
    git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
    const worktree = join(tmp(), 'wt')
    git(main, 'worktree', 'add', '-q', worktree)
    mkdirSync(join(worktree, 'apps', 'web'), { recursive: true })

    expect(await scriptStore(join(worktree, 'apps', 'web'))).toBe(join(main, 'apps', 'web', '.agent-view', 'scripts'))
  })

  it('uses the project dir itself outside git', async () => {
    const dir = tmp()
    expect(await scriptStore(dir)).toBe(join(dir, '.agent-view', 'scripts'))
  })
})

describe('markParams', () => {
  const script = {
    until: { selector: '[data-testid="row-library/Насосы/Насос"][aria-selected]' },
    steps: [
      { op: 'click' as const, target: { testid: 'row-library/Насосы/Насос', role: 'button', name: 'Насос' }, isPassword: false },
      { op: 'type' as const, target: { role: 'textbox', name: 'Имя' }, value: 'Насос', isPassword: false },
    ],
  }

  it('turns every occurrence of a value, in steps and the until, into ${NAME}, longest value first', () => {
    const marked = markParams(script, ['NAME=Насос', 'ROW=library/Насосы/Насос'])

    expect(marked).toMatchObject({
      until: { selector: '[data-testid="row-${ROW}"][aria-selected]' },
      steps: [{ target: { testid: 'row-${ROW}', name: '${NAME}' } }, { value: '${NAME}' }],
    })
    expect(paramsOf(marked as typeof script)).toEqual(['NAME', 'ROW'])
  })

  it('marks the --height of a goto step, which a script saves as typed', () => {
    const gotoScript = { until: { testid: 'camera' }, steps: [{ op: 'goto' as const, place: { scene: 'Tower 3' }, height: '2000' }] }

    expect(markParams(gotoScript, ['HEIGHT=2000'])).toMatchObject({ steps: [{ height: '${HEIGHT}' }] })
  })

  it('refuses a value that occurs nowhere, so a typo does not save a fixed script', () => {
    expect(markParams(script, ['ROW=library/Нет'])).toEqual({ error: '--param ROW: "library/Нет" is in no step and not in the until' })
  })
})
