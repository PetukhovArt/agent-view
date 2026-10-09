import { describe, expect, it } from 'vitest'
import { parseKeys } from '../keys.js'

describe('parseKeys', () => {
  // Apps match a hotkey on `key`, `code` or the legacy `keyCode`: a press must carry all three as a US keyboard sends them.
  it.each([
    ['ctrl+z', { modifiers: ['ctrl'], def: { key: 'z', code: 'KeyZ', keyCode: 90 } }],
    ['ctrl+shift+Z', { modifiers: ['ctrl', 'shift'], def: { key: 'Z', code: 'KeyZ', keyCode: 90 } }],
    ['shift+1', { modifiers: ['shift'], def: { key: '!', code: 'Digit1', keyCode: 49 }, text: '!' }],
    ['ctrl++', { modifiers: ['ctrl'], def: { key: '+', code: 'Equal', keyCode: 187 } }],
    ['Delete', { modifiers: [], def: { key: 'Delete', code: 'Delete', keyCode: 46 } }],
    ['esc', { modifiers: [], def: { key: 'Escape', code: 'Escape', keyCode: 27 } }],
    ['enter', { modifiers: [], def: { key: 'Enter', code: 'Enter', keyCode: 13 }, text: '\r' }],
    ['space', { modifiers: [], def: { key: ' ', code: 'Space', keyCode: 32 }, text: ' ' }],
    ['F5', { modifiers: [], def: { key: 'F5', code: 'F5', keyCode: 116 } }],
    ['Numpad7', { modifiers: [], def: { key: '7', code: 'Numpad7', keyCode: 103, location: 3 }, text: '7' }],
    ['ctrl+я', { modifiers: ['ctrl'], def: { key: 'я', code: '', keyCode: 0 } }],
  ])('%s', (raw, chord) => {
    expect(parseKeys(raw)).toEqual([chord])
  })

  it('reads space-separated chords as presses in turn', () => {
    const chords = parseKeys('ctrl+k  ctrl+c')

    expect(Array.isArray(chords) && chords.map(c => `${c.modifiers.join('+')}+${c.def.key}`)).toEqual(['ctrl+k', 'ctrl+c'])
  })

  it.each([
    ['hyper+z', 'hyper is no modifier'],
    ['ctrl+Escap', 'no key Escap'],
    ['  ', 'no keys'],
  ])('refuses %j', (raw, error) => {
    expect(parseKeys(raw)).toEqual({ error: expect.stringContaining(error) })
  })
})
