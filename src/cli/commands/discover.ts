import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

export async function runDiscover(config: AgentViewConfig): Promise<void> {
  const response = await sendCommand({
    command: 'discover',
    port: config.port,
    runtime: config.runtime,
    args: {},
  })

  if (!response.ok) {
    console.error(`Error: ${response.error}`)
    process.exit(1)
  }

  console.log(JSON.stringify(response.data, null, 2))
}
