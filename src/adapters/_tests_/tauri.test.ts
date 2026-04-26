import { describe, it, expect } from 'vitest'
import { isAppTarget } from '../tauri.js'

describe('isAppTarget (Tauri)', () => {
  it('accepts regular page targets', () => {
    expect(isAppTarget({ type: 'page', url: 'http://localhost:1420/', title: 'My App' })).toBe(true)
  })

  it('accepts tauri://localhost targets', () => {
    expect(isAppTarget({ type: 'page', url: 'tauri://localhost', title: 'App' })).toBe(true)
  })

  it('rejects about:blank', () => {
    expect(isAppTarget({ type: 'page', url: 'about:blank', title: '' })).toBe(false)
  })

  it('rejects devtools:// targets', () => {
    expect(isAppTarget({ type: 'page', url: 'devtools://devtools/inspector.html', title: 'DevTools' })).toBe(false)
  })

  it('rejects chrome-extension:// targets', () => {
    expect(isAppTarget({ type: 'page', url: 'chrome-extension://abc/popup.html', title: 'Ext' })).toBe(false)
  })

  it('rejects non-page targets', () => {
    expect(isAppTarget({ type: 'background_page', url: 'http://localhost:1420/', title: '' })).toBe(false)
  })
})
