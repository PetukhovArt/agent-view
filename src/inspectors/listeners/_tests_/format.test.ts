import { describe, it, expect } from 'vitest'
import { formatListeners } from '../index.js'
import type { EventListenerInfo } from '../../../cdp/types.js'

const listener = (over: Partial<EventListenerInfo> = {}): EventListenerInfo => ({
  type: 'click',
  useCapture: false,
  passive: false,
  once: false,
  scriptId: '7',
  url: '/src/OrderForm.vue',
  lineNumber: 87,
  columnNumber: 13,
  ...over,
})

describe('formatListeners', () => {
  // A node with no handlers is a real answer to "what is wired to this button",
  // and the skill teaches agents to read this exact line rather than an error.
  it('reports a bare node as a valid answer', () => {
    expect(formatListeners('"Save" [ref=12]', [])).toBe(
      '"Save" [ref=12]\n  (no listeners on this node)',
    )
  })

  it('prints CDP 0-based positions as 1-based file locations', () => {
    expect(formatListeners('[ref=3]', [listener()])).toBe(
      '[ref=3]\n  click  /src/OrderForm.vue:88:14',
    )
  })

  it('falls back to the raw scriptId when the URL could not be resolved', () => {
    expect(formatListeners('[ref=3]', [listener({ url: '' })]))
      .toContain('scriptId:7:88:14')
  })

  it('prints only the flags that are set', () => {
    const out = formatListeners('[ref=3]', [listener({ useCapture: true, once: true })])
    expect(out).toContain('(capture, once)')
    expect(out).not.toContain('passive')
    expect(formatListeners('[ref=3]', [listener()])).not.toContain('(')
  })
})
