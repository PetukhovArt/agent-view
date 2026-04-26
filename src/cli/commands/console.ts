import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

export type ConsoleOptions = {
  target?: string
  follow?: boolean
  timeout?: number
  level?: string
  since?: string
  clear?: boolean
}

export async function runConsole(config: AgentViewConfig, options: ConsoleOptions): Promise<void> {
  const levels = options.level
    ? options.level.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : undefined

  const since = options.since ? Date.parse(options.since) : undefined
  if (options.since && Number.isNaN(since)) {
    console.error(`Invalid --since timestamp: "${options.since}"`)
    process.exit(1)
  }

  const response = await sendCommand({
    command: 'console',
    port: config.port,
    runtime: config.runtime,
    args: {
      target: options.target,
      follow: options.follow,
      timeout: options.timeout,
      levels,
      since,
      clear: options.clear,
      cwd: process.cwd(),
    },
  })

  if (!response.ok) {
    console.error(`Error: ${response.error}`)
    process.exit(1)
  }

  console.log(response.data)
}
