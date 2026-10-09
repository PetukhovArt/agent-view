import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type KeyOptions = {
  testid?: string
  selector?: string
  window?: string
}

export async function runKey(config: AgentViewConfig, keys: string, options: KeyOptions): Promise<void> {
  const response = await sendCommand({
    command: 'key',
    port: config.port,
    runtime: config.runtime,
    args: { keys, testid: options.testid, selector: options.selector, window: options.window, testIdAttribute: config.testIdAttribute },
  })

  if (response.ok) {
    console.log(response.data)
  } else {
    console.error(response.error)
    process.exit(1)
  }
}
