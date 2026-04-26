import { describe, it, expect } from 'vitest'
import { diff, checkSizeCap, readCapture, WatchSizeCapError } from '../index.js'

describe('diff', () => {
  it('primitive replace at root', () => {
    expect(diff(100, 150)).toEqual([{ op: 'replace', path: '', value: 150 }])
  })

  it('primitive identity → empty', () => {
    expect(diff(5, 5)).toEqual([])
    expect(diff('x', 'x')).toEqual([])
  })

  it('object key add', () => {
    const ops = diff({ a: 1 }, { a: 1, b: 2 })
    expect(ops).toEqual([{ op: 'add', path: '/b', value: 2 }])
  })

  it('object key remove', () => {
    const ops = diff({ a: 1, b: 2 }, { a: 1 })
    expect(ops).toEqual([{ op: 'remove', path: '/b' }])
  })

  it('object key replace', () => {
    const ops = diff({ a: 1 }, { a: 2 })
    expect(ops).toEqual([{ op: 'replace', path: '/a', value: 2 }])
  })

  it('array push', () => {
    const ops = diff([1, 2], [1, 2, 3])
    expect(ops).toEqual([{ op: 'add', path: '/2', value: 3 }])
  })

  it('array pop', () => {
    const ops = diff([1, 2, 3], [1, 2])
    expect(ops).toEqual([{ op: 'remove', path: '/2' }])
  })

  it('nested mutation depth 3', () => {
    const a = { user: { profile: { name: 'Alice' } } }
    const b = { user: { profile: { name: 'Bob' } } }
    expect(diff(a, b)).toEqual([{ op: 'replace', path: '/user/profile/name', value: 'Bob' }])
  })

  it('object → array root type change', () => {
    const ops = diff({ a: 1 }, [1, 2])
    expect(ops).toEqual([{ op: 'replace', path: '', value: [1, 2] }])
  })

  it('null → object', () => {
    const ops = diff(null, { a: 1 })
    expect(ops).toEqual([{ op: 'replace', path: '', value: { a: 1 } }])
  })

  it('identity object → empty', () => {
    expect(diff({ a: 1 }, { a: 1 })).toEqual([])
  })

  it('wrapper-error payload diff like a normal value', () => {
    const a = { __watchError: 'boom' }
    const b = { name: 'real' }
    const ops = diff(a, b)
    expect(ops).toContainEqual({ op: 'remove', path: '/__watchError' })
    expect(ops).toContainEqual({ op: 'add', path: '/name', value: 'real' })
  })
})

describe('checkSizeCap', () => {
  it('passes small value', () => {
    expect(() => checkSizeCap({ a: 1 })).not.toThrow()
  })

  it('throws on > 256KB', () => {
    const big = { data: 'x'.repeat(300_000) }
    expect(() => checkSizeCap(big)).toThrow(WatchSizeCapError)
  })
})

describe('readCapture', () => {
  it('plain value', () => {
    expect(readCapture({ a: 1 })).toEqual({ kind: 'value', value: { a: 1 } })
    expect(readCapture(42)).toEqual({ kind: 'value', value: 42 })
    expect(readCapture(null)).toEqual({ kind: 'value', value: null })
  })

  it('error payload', () => {
    expect(readCapture({ __watchError: 'oops' })).toEqual({ kind: 'error', message: 'oops' })
  })
})
