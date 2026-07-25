import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

export type LogsAction = 'start' | 'stop' | 'status' | 'tail' | 'clear'

export type LogsOptions = {
  file?: string
  target?: string
  level?: string
  rescan?: number
  truncate?: boolean
  probe?: string[]
  lines?: number
  grep?: string
  since?: string
}

type ProbePayload = { name: string; source: string; targetQuery?: string }

export async function runLogs(config: AgentViewConfig, action: LogsAction, options: LogsOptions): Promise<void> {
  const levels = options.level
    ? options.level.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : undefined

  const response = await sendCommand({
    command: 'logs',
    port: config.port,
    runtime: config.runtime,
    args: {
      action,
      file: options.file,
      target: options.target,
      levels,
      rescan: options.rescan,
      truncate: options.truncate,
      probes: action === 'start' ? readProbes(options.probe) : undefined,
      lines: options.lines,
      grep: options.grep,
      since: options.since,
      cwd: process.cwd(),
    },
  })

  if (!response.ok) {
    console.error(`Error: ${response.error}`)
    process.exit(1)
  }
  if (response.warning) console.error(response.warning)
  console.log(response.data)
}

/** `--probe path[@targetQuery]` — the file is read here so the server never touches agent paths. */
function readProbes(specs: string[] | undefined): ProbePayload[] {
  if (!specs || specs.length === 0) return []
  return specs.map((spec) => {
    const at = spec.lastIndexOf('@')
    const path = at > 0 ? spec.slice(0, at) : spec
    const targetQuery = at > 0 ? spec.slice(at + 1) : undefined
    try {
      return { name: basename(path), source: readFileSync(path, 'utf8'), targetQuery }
    } catch (err) {
      console.error(`Cannot read probe "${path}": ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })
}
