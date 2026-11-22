import { resolve } from 'node:path'
import { sendCommand } from '../client.js'
import { formatAudit, type AuditResult } from '../../inspectors/audit/index.js'
import type { AgentViewConfig } from '../../config/types.js'

const EXIT_UNUSABLE = 2
const DEFAULT_MAX_LINES = 50

type AuditOptions = {
  window?: string
  root?: string
  rules?: string
  minTarget?: number
  shot?: string
  scene?: boolean
  maxLines?: number
  json?: boolean
}

export async function runAudit(config: AgentViewConfig, options: AuditOptions): Promise<void> {
  const args: Record<string, unknown> = { testIdAttribute: config.testIdAttribute }
  if (options.window) args.window = options.window
  if (options.root !== undefined) args.root = options.root
  if (options.rules !== undefined) args.rules = options.rules.split(',').map(r => r.trim()).filter(Boolean)
  if (options.minTarget !== undefined) args.minTarget = options.minTarget
  if (options.shot !== undefined) args.shot = resolve(options.shot)
  if (options.scene) args.scene = true

  const response = await sendCommand({ command: 'audit', port: config.port, runtime: config.runtime, engine: config.webgl?.engine, args })

  if (!response.ok) {
    console.error(response.error)
    process.exit(EXIT_UNUSABLE)
  }
  const result = response.data as AuditResult & { shot?: string }
  if (options.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(formatAudit(result, options.maxLines ?? DEFAULT_MAX_LINES))
    if (result.shot) console.log(`shot: ${result.shot}`)
  }
  if (response.exitCode) process.exit(response.exitCode)
}

