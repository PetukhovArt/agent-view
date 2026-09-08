import { describe, it, expect } from 'vitest'
import { formatCoverage } from '../index.js'
import type { CoverageScript } from '../../../cdp/types.js'

const script = (url: string, ...fns: Array<[string, number, number?]>): CoverageScript => ({
  scriptId: url || '9',
  url,
  functions: fns.map(([name, count, offset]) => ({ name, count, offset: offset ?? 0 })),
})

describe('formatCoverage', () => {
  // The skill tells agents to expect this literal string as the "nothing ran"
  // answer; changing it turns a valid negative result into an unrecognised one.
  it('reports an empty delta as a valid answer, not as an error', () => {
    expect(formatCoverage([])).toEqual({ text: '(no code executed since --clear)', functions: 0 })
  })

  it('names the filter back when it matched nothing', () => {
    const scripts = [script('/src/a.ts', ['run', 1])]
    expect(formatCoverage(scripts, { filter: 'nope' }).text).toBe('(no code matching "nope")')
  })

  it('keeps the tail inside the --max-lines budget', () => {
    const scripts = [script('/src/a.ts', ['a', 1], ['b', 1], ['c', 1], ['d', 1])]
    const lines = formatCoverage(scripts, { maxLines: 3 }).text.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[2]).toBe('… 3 more lines')
  })

  it('hides library and url-less scripts by default and says how many', () => {
    const scripts = [
      script('/src/a.ts', ['run', 1]),
      script('/node_modules/vue/dist/vue.js', ['effect', 9]),
      script('', ['evaled', 1]),
    ]
    const out = formatCoverage(scripts)
    expect(out.functions).toBe(1)
    expect(out.text).toContain('… 2 scripts hidden (--all to show)')
    expect(out.text).not.toContain('node_modules')
  })

  it('--all brings the hidden scripts back', () => {
    const scripts = [script('/src/a.ts', ['run', 1]), script('', ['evaled', 1])]
    const out = formatCoverage(scripts, { all: true })
    expect(out.functions).toBe(2)
    expect(out.text).toContain('(no url)')
    expect(out.text).not.toContain('hidden')
  })

  it('labels an unnamed function by its byte offset so two of them stay distinct', () => {
    const scripts = [script('/src/a.ts', ['', 1, 1420], ['', 1, 88])]
    expect(formatCoverage(scripts).text).toContain('<anonymous>@1420')
    expect(formatCoverage(scripts).text).toContain('<anonymous>@88')
  })

  it('matches the filter against the script URL as well as the function name', () => {
    const scripts = [script('/src/OrderForm.vue', ['a', 1], ['b', 1]), script('/src/other.ts', ['zzHandler', 1])]
    expect(formatCoverage(scripts, { filter: 'OrderForm' }).functions).toBe(2)
    expect(formatCoverage(scripts, { filter: 'zzHandler' }).functions).toBe(1)
  })
})
