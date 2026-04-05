import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type WaitOptions = {
  filter: string
  timeout?: string
  window?: string
}

export async function runWait(config: AgentViewConfig, options: WaitOptions): Promise<void> {
  if (!options.filter) {
    console.error('Usage: agent-view wait --filter <text> [--timeout <seconds>]')
    process.exit(1)
  }

  const timeout = options.timeout ? parseInt(options.timeout, 10) : 10

  const response = await sendCommand({
    command: 'wait',
    port: config.port,
    runtime: config.runtime,
    args: {
      filter: options.filter,
      timeout,
      window: options.window,
    },
  })

  if (response.ok) {
    console.log(response.data)
  } else {
    console.error(response.error)
    process.exit(1)
  }
}
