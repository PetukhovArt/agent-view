import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

export type NetworkOptions = {
  req?: string
  url?: string
  method?: string
  status?: string
  type?: string
  rawHeaders?: boolean
  follow?: boolean
  until?: string
  timeout?: string
  maxLines?: string
  since?: string
  clear?: boolean
  target?: string
  window?: string
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  const parts = value.split(',').map(s => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts : undefined
}

function parseIntOrExit(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`Invalid ${name}: "${raw}"`)
    process.exit(1)
  }
  return n
}

export async function runNetwork(config: AgentViewConfig, options: NetworkOptions): Promise<void> {
  const req = parseIntOrExit(options.req, '--req')
  const maxLines = parseIntOrExit(options.maxLines, '--max-lines')
  const timeout = parseIntOrExit(options.timeout, '--timeout')

  const since = options.since ? Date.parse(options.since) : undefined
  if (options.since && Number.isNaN(since)) {
    console.error(`Invalid --since timestamp: "${options.since}"`)
    process.exit(1)
  }

  const response = await sendCommand({
    command: 'network',
    port: config.port,
    runtime: config.runtime,
    args: {
      req,
      url: options.url,
      method: splitList(options.method),
      status: splitList(options.status),
      type: splitList(options.type),
      rawHeaders: options.rawHeaders,
      follow: options.follow,
      until: options.until,
      timeout,
      maxLines,
      since,
      clear: options.clear,
      target: options.target,
      window: options.window,
      cwd: process.cwd(),
    },
  })

  if (!response.ok) {
    console.error(`Error: ${response.error}`)
    process.exit(1)
  }

  console.log(response.data)
}
