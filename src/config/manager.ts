import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentViewConfig } from './types.js'
import { RuntimeType, WebGLEngine } from '../types.js'

const CONFIG_FILENAME = 'agent-view.config.json'

export function readConfig(cwd: string): AgentViewConfig | null {
  const configPath = join(cwd, CONFIG_FILENAME)
  if (!existsSync(configPath)) return null
  const raw = readFileSync(configPath, 'utf-8')
  const parsed: unknown = JSON.parse(raw)
  if (!isValidConfig(parsed)) {
    throw new Error(`Invalid agent-view.config.json: must have runtime, port (number), and launch (string)`)
  }
  return parsed
}

function isValidConfig(obj: unknown): obj is AgentViewConfig {
  if (!obj || typeof obj !== 'object') return false
  const c = obj as Record<string, unknown>
  const validRuntimes: string[] = Object.values(RuntimeType)
  const validEngines: string[] = Object.values(WebGLEngine)
  if (
    typeof c.runtime !== 'string' ||
    !validRuntimes.includes(c.runtime) ||
    typeof c.port !== 'number' ||
    c.port < 1 || c.port > 65535 ||
    typeof c.launch !== 'string'
  ) return false

  // Validate optional webgl.engine
  if (c.webgl !== undefined) {
    if (!c.webgl || typeof c.webgl !== 'object') return false
    const w = c.webgl as Record<string, unknown>
    if (typeof w.engine !== 'string' || !validEngines.includes(w.engine)) return false
  }

  if (c.allowEval !== undefined && typeof c.allowEval !== 'boolean') return false
  if (c.consoleBufferSize !== undefined) {
    if (typeof c.consoleBufferSize !== 'number' || c.consoleBufferSize < 1) return false
  }
  if (c.consoleTargets !== undefined) {
    if (!Array.isArray(c.consoleTargets) || !c.consoleTargets.every(t => typeof t === 'string')) return false
  }

  return true
}

export function generateConfig(cwd: string): AgentViewConfig {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) {
    throw new Error(`package.json not found in ${cwd}`)
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }

  const runtime = detectRuntime(allDeps)
  const webglEngine = detectWebGL(allDeps)
  const launch = detectLaunchCommand(cwd, pkg.scripts)

  const config: AgentViewConfig = {
    runtime,
    port: 9876,
    launch,
  }

  if (webglEngine) {
    config.webgl = { engine: webglEngine }
  }

  return config
}

export function writeConfig(cwd: string, config: AgentViewConfig): void {
  const configPath = join(cwd, CONFIG_FILENAME)
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
}

function detectRuntime(deps: Record<string, string>): RuntimeType {
  if (deps['electron'] || deps['electron-vite']) return RuntimeType.Electron
  if (deps['@tauri-apps/api'] || deps['@tauri-apps/cli']) return RuntimeType.Tauri
  return RuntimeType.Browser
}

function detectWebGL(deps: Record<string, string>): WebGLEngine | undefined {
  if (deps['pixi.js'] || deps['@pixi/app']) return WebGLEngine.Pixi
  return undefined
}

function detectLaunchCommand(cwd: string, scripts?: Record<string, string>): string {
  const pm = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'
  if (!scripts) return `${pm} run dev`
  if (scripts['dev']) return `${pm} run dev`
  if (scripts['start']) return `${pm} start`
  return `${pm} run dev`
}
