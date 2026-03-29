import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentViewConfig } from './types.js'
import type { RuntimeType, WebGLEngine } from '../types.js'

const CONFIG_FILENAME = 'agent-view.config.json'

export function readConfig(cwd: string): AgentViewConfig | null {
  const configPath = join(cwd, CONFIG_FILENAME)
  if (!existsSync(configPath)) return null
  const raw = readFileSync(configPath, 'utf-8')
  return JSON.parse(raw) as AgentViewConfig
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
    port: 9222,
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
  if (deps['electron'] || deps['electron-vite']) return 'electron'
  if (deps['@tauri-apps/api'] || deps['@tauri-apps/cli']) return 'tauri'
  return 'browser'
}

function detectWebGL(deps: Record<string, string>): WebGLEngine | undefined {
  if (deps['pixi.js'] || deps['@pixi/app']) return 'pixi'
  if (deps['cesium']) return 'cesium'
  if (deps['three']) return 'three'
  return undefined
}

function detectLaunchCommand(cwd: string, scripts?: Record<string, string>): string {
  const pm = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : 'npm'
  if (!scripts) return `${pm} run dev`
  if (scripts['dev']) return `${pm} run dev`
  if (scripts['start']) return `${pm} start`
  return `${pm} run dev`
}
