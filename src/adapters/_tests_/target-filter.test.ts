import { describe, it, expect } from 'vitest'
import { isAppTarget } from '../target-filter.js'

describe('isAppTarget', () => {
  it('accepts a regular app page', () => {
    expect(isAppTarget({ type: 'page', url: 'http://localhost:8080/src/index.html', title: 'App' })).toBe(true)
  })

  // Regression: opening DevTools registers a first-in-list `devtools://` page target;
  // default window selection must not pick it over the real app window.
  it('rejects the DevTools frontend page', () => {
    expect(isAppTarget({ type: 'page', url: 'devtools://devtools/bundled/devtools_app.html', title: 'DevTools' })).toBe(false)
  })

  it('rejects about:blank', () => {
    expect(isAppTarget({ type: 'page', url: 'about:blank', title: '' })).toBe(false)
  })

  it('rejects chrome-extension pages', () => {
    expect(isAppTarget({ type: 'page', url: 'chrome-extension://abc/popup.html', title: 'Ext' })).toBe(false)
  })

  it('rejects non-page targets', () => {
    expect(isAppTarget({ type: 'shared_worker', url: 'http://localhost:8080/worker.js', title: '' })).toBe(false)
  })
})
