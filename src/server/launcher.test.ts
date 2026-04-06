import { describe, it, expect } from 'vitest'
import { parseCommand } from './launcher.js'

describe('parseCommand', () => {
  it('splits simple command', () => {
    const [exe, args] = parseCommand('node server.js')
    expect(exe).toBe('node')
    expect(args).toEqual(['server.js'])
  })

  it('handles quoted arguments', () => {
    const [exe, args] = parseCommand('echo "hello world"')
    expect(exe).toBe('echo')
    expect(args).toEqual(['hello world'])
  })

  it('handles single-quoted arguments', () => {
    const [exe, args] = parseCommand("echo 'hello world'")
    expect(exe).toBe('echo')
    expect(args).toEqual(['hello world'])
  })

  it('adds .cmd suffix for npm on Windows', () => {
    const [exe] = parseCommand('npm run dev')
    if (process.platform === 'win32') {
      expect(exe).toBe('npm.cmd')
    } else {
      expect(exe).toBe('npm')
    }
  })

  it('adds .cmd suffix for pnpm on Windows', () => {
    const [exe] = parseCommand('pnpm run dev')
    if (process.platform === 'win32') {
      expect(exe).toBe('pnpm.cmd')
    } else {
      expect(exe).toBe('pnpm')
    }
  })

  it('returns empty args for single-word command', () => {
    const [exe, args] = parseCommand('electron')
    expect(args).toEqual([])
  })
})
