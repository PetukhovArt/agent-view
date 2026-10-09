import { MODIFIERS, type Modifier } from './types.js'

/** What `Input.dispatchKeyEvent` needs of one key: `keyCode` is the Windows virtual key code, 0 off the US layout. */
export type KeyDef = { key: string; code: string; keyCode: number; location?: number }

/** One press: modifiers held around the key; `text` is what it types, set only for a printable key without ctrl/alt/meta. */
export type KeyChord = { modifiers: Modifier[]; def: KeyDef; text?: string }

export const MODIFIER_KEYS: Record<Modifier, KeyDef> = {
  alt: { key: 'Alt', code: 'AltLeft', keyCode: 18, location: 1 },
  ctrl: { key: 'Control', code: 'ControlLeft', keyCode: 17, location: 1 },
  meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91, location: 1 },
  shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1 },
}

const named = (key: string, keyCode: number, code = key): [string, KeyDef] => [key.toLowerCase(), { key, code, keyCode }]
const numpad = (code: string, key: string, keyCode: number): [string, KeyDef] => [code.toLowerCase(), { key, code, keyCode, location: 3 }]

/** DOM `key` names, lowercased; numpad keys by their `code`, as their `key` is a digit or a sign. */
const NAMED = new Map<string, KeyDef>([
  named('Enter', 13), named('Tab', 9), named('Escape', 27), named('Backspace', 8), named('Delete', 46),
  named('Insert', 45), named('Home', 36), named('End', 35), named('PageUp', 33), named('PageDown', 34),
  named('ArrowLeft', 37), named('ArrowUp', 38), named('ArrowRight', 39), named('ArrowDown', 40),
  named('CapsLock', 20), named('ContextMenu', 93), named('Pause', 19), named('PrintScreen', 44),
  named('NumLock', 144), named('ScrollLock', 145),
  ...Object.values(MODIFIER_KEYS).map((def): [string, KeyDef] => [def.key.toLowerCase(), def]),
  ...Array.from({ length: 24 }, (_, i) => named(`F${i + 1}`, 112 + i)),
  ...Array.from({ length: 10 }, (_, i) => numpad(`Numpad${i}`, String(i), 96 + i)),
  numpad('NumpadMultiply', '*', 106), numpad('NumpadAdd', '+', 107), numpad('NumpadSubtract', '-', 109),
  numpad('NumpadDecimal', '.', 110), numpad('NumpadDivide', '/', 111), numpad('NumpadEnter', 'Enter', 13),
])

/** Short names an agent types; `space` also because a bare space separates chords. */
const ALIASES: Record<string, string> = { esc: 'escape', del: 'delete', space: ' ', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright' }

/** US-layout punctuation: the key, its code, its virtual key code, and the character it types with shift. */
const PUNCTUATION: [string, string, number, string][] = [
  ['`', 'Backquote', 192, '~'], ['-', 'Minus', 189, '_'], ['=', 'Equal', 187, '+'], ['[', 'BracketLeft', 219, '{'],
  [']', 'BracketRight', 221, '}'], ['\\', 'Backslash', 220, '|'], [';', 'Semicolon', 186, ':'], ["'", 'Quote', 222, '"'],
  [',', 'Comma', 188, '<'], ['.', 'Period', 190, '>'], ['/', 'Slash', 191, '?'],
]
const SHIFTED_DIGITS = ')!@#$%^&*('

/** A single character: by its US-layout key when it has one, else the character alone (another layout's letter). */
function charKey(char: string): KeyDef {
  const lower = char.toLowerCase()
  if (/^[a-z]$/.test(lower)) return { key: lower, code: `Key${lower.toUpperCase()}`, keyCode: lower.toUpperCase().charCodeAt(0) }
  const digit = /^\d$/.test(char) ? Number(char) : SHIFTED_DIGITS.indexOf(char)
  if (digit >= 0) return { key: char, code: `Digit${digit}`, keyCode: 48 + digit }
  if (char === ' ') return { key: ' ', code: 'Space', keyCode: 32 }
  const punctuation = PUNCTUATION.find(([key, , , shifted]) => key === char || shifted === char)
  return punctuation ? { key: char, code: punctuation[1], keyCode: punctuation[2] } : { key: char, code: '', keyCode: 0 }
}

/** `ctrl+shift+z`: modifiers, then one key; `ctrl++` is ctrl and `+`. */
function parseChord(raw: string): KeyChord | { error: string } {
  const parts = raw.split(/\+(?=.)/)
  const name = parts.pop()!
  const modifiers: Modifier[] = []
  for (const part of parts) {
    const modifier = MODIFIERS.find(m => m === part.toLowerCase())
    if (!modifier) return { error: `"${raw}": ${part} is no modifier — ${MODIFIERS.join('|')}` }
    modifiers.push(modifier)
  }
  const lower = ALIASES[name.toLowerCase()] ?? name.toLowerCase()
  const char = lower === ' ' ? ' ' : [...name].length === 1 ? name : undefined
  const def = NAMED.get(lower) ?? (char === undefined ? undefined : charKey(char))
  if (!def) return { error: `"${raw}": no key ${name} — a DOM key name (Enter, Escape, ArrowDown, F5, Delete …) or one character` }
  const key = modifiers.includes('shift') ? shifted(def.key) : def.key
  const isTyping = !modifiers.some(m => m !== 'shift')
  const text = key === 'Enter' ? '\r' : [...key].length === 1 ? key : undefined
  return { modifiers, def: { ...def, key }, ...(isTyping && text ? { text } : {}) }
}

/** The `key` a US keyboard reports for `key` with shift held: `Z` for `z`, `!` for `1`. */
function shifted(key: string): string {
  if (/^[a-z]$/.test(key)) return key.toUpperCase()
  if (/^\d$/.test(key)) return SHIFTED_DIGITS[Number(key)]
  return PUNCTUATION.find(([unshifted]) => unshifted === key)?.[3] ?? key
}

/** Space-separated chords pressed in turn: `ctrl+k ctrl+c`, `ArrowDown ArrowDown Enter`. */
export function parseKeys(raw: string): KeyChord[] | { error: string } {
  const chords: KeyChord[] = []
  for (const part of raw.trim().split(/\s+/).filter(Boolean)) {
    const chord = parseChord(part)
    if ('error' in chord) return chord
    chords.push(chord)
  }
  return chords.length ? chords : { error: 'no keys — e.g. ctrl+z, Escape, "ArrowDown ArrowDown Enter"' }
}
