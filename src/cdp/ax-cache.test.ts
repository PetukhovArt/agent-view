import { describe, it, expect, vi, afterEach } from 'vitest'
import { AxTreeCache } from './ax-cache.js'
import type { AXNode } from './types.js'

const NODES: AXNode[] = [{ nodeId: '1', ignored: false }] as unknown as AXNode[]

describe('AxTreeCache', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null on empty cache', () => {
    const cache = new AxTreeCache()
    expect(cache.get('key')).toBeNull()
  })

  it('returns nodes within TTL', () => {
    vi.useFakeTimers()
    const cache = new AxTreeCache()
    cache.set('k', NODES)
    vi.advanceTimersByTime(299)
    expect(cache.get('k')).toBe(NODES)
  })

  it('returns null after TTL expires', () => {
    vi.useFakeTimers()
    const cache = new AxTreeCache()
    cache.set('k', NODES)
    vi.advanceTimersByTime(301)
    expect(cache.get('k')).toBeNull()
  })

  it('invalidate clears specific key and leaves others', () => {
    const cache = new AxTreeCache()
    cache.set('a', NODES)
    cache.set('b', NODES)
    cache.invalidate('a')
    expect(cache.get('a')).toBeNull()
    expect(cache.get('b')).toBe(NODES)
  })

  it('set overwrites existing entry and resets timestamp', () => {
    vi.useFakeTimers()
    const cache = new AxTreeCache()
    const nodes2: AXNode[] = [{ nodeId: '2', ignored: false }] as unknown as AXNode[]
    cache.set('k', NODES)
    vi.advanceTimersByTime(200)
    cache.set('k', nodes2)
    vi.advanceTimersByTime(200) // 200ms since last set → still valid
    expect(cache.get('k')).toBe(nodes2)
  })

  it('invalidateAll clears all entries', () => {
    const cache = new AxTreeCache()
    cache.set('a', NODES)
    cache.set('b', NODES)
    cache.invalidateAll()
    expect(cache.get('a')).toBeNull()
    expect(cache.get('b')).toBeNull()
  })
})
