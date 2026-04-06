import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readConfig, generateConfig, writeConfig } from './manager.js'
import { RuntimeType, WebGLEngine } from '../types.js'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'agent-view-test-'))
}

function writePkg(dir: string, deps: Record<string, string> = {}, scripts?: Record<string, string>) {
  const pkg = { dependencies: deps, ...(scripts ? { scripts } : {}) }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf-8')
}

describe('readConfig', () => {
  let tmpDir: string

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when no config file', () => {
    tmpDir = makeTempDir()
    expect(readConfig(tmpDir)).toBeNull()
  })

  it('reads a valid config', () => {
    tmpDir = makeTempDir()
    const config = { runtime: RuntimeType.Electron, port: 9222, launch: 'npm run dev' }
    writeFileSync(join(tmpDir, 'agent-view.config.json'), JSON.stringify(config), 'utf-8')
    expect(readConfig(tmpDir)).toEqual(config)
  })

  it('reads config with webgl field', () => {
    tmpDir = makeTempDir()
    const config = {
      runtime: RuntimeType.Browser,
      port: 9222,
      launch: 'npm run dev',
      webgl: { engine: WebGLEngine.Pixi },
    }
    writeFileSync(join(tmpDir, 'agent-view.config.json'), JSON.stringify(config), 'utf-8')
    expect(readConfig(tmpDir)).toEqual(config)
  })

  it('throws on invalid runtime', () => {
    tmpDir = makeTempDir()
    const config = { runtime: 'invalid-runtime', port: 9222, launch: 'npm run dev' }
    writeFileSync(join(tmpDir, 'agent-view.config.json'), JSON.stringify(config), 'utf-8')
    expect(() => readConfig(tmpDir)).toThrow()
  })

  it('throws on port 0', () => {
    tmpDir = makeTempDir()
    const config = { runtime: RuntimeType.Browser, port: 0, launch: 'npm run dev' }
    writeFileSync(join(tmpDir, 'agent-view.config.json'), JSON.stringify(config), 'utf-8')
    expect(() => readConfig(tmpDir)).toThrow()
  })

  it('throws on port > 65535', () => {
    tmpDir = makeTempDir()
    const config = { runtime: RuntimeType.Browser, port: 65536, launch: 'npm run dev' }
    writeFileSync(join(tmpDir, 'agent-view.config.json'), JSON.stringify(config), 'utf-8')
    expect(() => readConfig(tmpDir)).toThrow()
  })
})

describe('generateConfig', () => {
  let tmpDir: string

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('throws when no package.json', () => {
    tmpDir = makeTempDir()
    expect(() => generateConfig(tmpDir)).toThrow(/package\.json/)
  })

  it('detects electron runtime', () => {
    tmpDir = makeTempDir()
    writePkg(tmpDir, { electron: '^28.0.0' })
    const config = generateConfig(tmpDir)
    expect(config.runtime).toBe(RuntimeType.Electron)
  })

  it('detects tauri runtime via @tauri-apps/api', () => {
    tmpDir = makeTempDir()
    writePkg(tmpDir, { '@tauri-apps/api': '^2.0.0' })
    const config = generateConfig(tmpDir)
    expect(config.runtime).toBe(RuntimeType.Tauri)
  })

  it('defaults to browser when no known runtime dep', () => {
    tmpDir = makeTempDir()
    writePkg(tmpDir, { react: '^18.0.0' })
    const config = generateConfig(tmpDir)
    expect(config.runtime).toBe(RuntimeType.Browser)
  })

  it('detects pixi.js engine', () => {
    tmpDir = makeTempDir()
    writePkg(tmpDir, { 'pixi.js': '^8.0.0' })
    const config = generateConfig(tmpDir)
    expect(config.webgl).toEqual({ engine: WebGLEngine.Pixi })
  })

  it('sets no webgl when no known engine dep', () => {
    tmpDir = makeTempDir()
    writePkg(tmpDir, {})
    const config = generateConfig(tmpDir)
    expect(config.webgl).toBeUndefined()
  })

  it('uses pnpm when pnpm-lock.yaml exists', () => {
    tmpDir = makeTempDir()
    writePkg(tmpDir, {}, { dev: 'vite' })
    writeFileSync(join(tmpDir, 'pnpm-lock.yaml'), '', 'utf-8')
    const config = generateConfig(tmpDir)
    expect(config.launch).toBe('pnpm run dev')
  })

  it('uses npm when no pnpm-lock.yaml', () => {
    tmpDir = makeTempDir()
    writePkg(tmpDir, {}, { dev: 'vite' })
    const config = generateConfig(tmpDir)
    expect(config.launch).toBe('npm run dev')
  })
})

describe('writeConfig', () => {
  let tmpDir: string

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes and reads back correctly', () => {
    tmpDir = makeTempDir()
    const config = {
      runtime: RuntimeType.Electron,
      port: 9222,
      launch: 'pnpm run dev',
      webgl: { engine: WebGLEngine.Pixi },
    }
    writeConfig(tmpDir, config)
    expect(readConfig(tmpDir)).toEqual(config)
  })
})
