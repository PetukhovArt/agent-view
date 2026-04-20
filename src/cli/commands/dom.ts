import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type DomOptions = {
  window?: string
  filter?: string
  depth?: number
  text?: boolean
}

export async function runDom(config: AgentViewConfig, options: DomOptions): Promise<void> {
  const response = await sendCommand({
    command: 'dom',
    port: config.port,
    runtime: config.runtime,
    args: {
      window: options.window,
      filter: options.filter,
      depth: options.depth,
      text: options.text,
    },
  })

  if (!response.ok) {
    console.error(`Error: ${response.error}`)
    process.exit(1)
  }

  console.log(response.data)
}
