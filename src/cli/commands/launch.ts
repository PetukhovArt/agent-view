import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

export async function runLaunch(config: AgentViewConfig): Promise<void> {
  if (!config.launch) {
    console.error('No launch command configured. Add "launch" to agent-view.config.json.')
    process.exit(1)
  }

  const response = await sendCommand({
    command: 'launch',
    port: config.port,
    runtime: config.runtime,
    args: { launch: config.launch, cwd: process.cwd() },
  })

  if (response.ok) {
    console.log(response.data)
  } else {
    console.error(response.error)
    process.exit(1)
  }
}
