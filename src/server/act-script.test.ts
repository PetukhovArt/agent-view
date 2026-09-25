import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { edgePoint, scriptStore } from './act-script.js'

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
