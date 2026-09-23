import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type WaitOptions = {
  filter?: string
  testid?: string
  selector?: string
  timeout?: string
  window?: string
}

export async function runWait(config: AgentViewConfig, options: WaitOptions): Promise<void> {
  const ways = [options.filter, options.testid, options.selector].filter(f => f !== undefined)
  if (ways.length !== 1) {
    console.error('Usage: agent-view wait --filter <text> | --testid <id> | --selector <css> [--timeout <seconds>] — exactly one')
    process.exit(1)
  }

  const timeout = options.timeout ? parseInt(options.timeout, 10) : 10

  const response = await sendCommand({
    command: 'wait',
    port: config.port,
    runtime: config.runtime,
    args: {
      filter: options.filter,
      testid: options.testid,
      selector: options.selector,
      testIdAttribute: config.testIdAttribute,
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
