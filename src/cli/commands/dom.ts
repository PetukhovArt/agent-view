import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type DomOptions = {
  window?: string
  filter?: string
  depth?: number
  text?: boolean
  diff?: boolean
}

export async function runDom(config: AgentViewConfig, options: DomOptions): Promise<void> {
  const args: Record<string, unknown> = {}
  if (options.window) args.window = options.window
  if (options.filter) args.filter = options.filter
  if (options.depth !== undefined) args.depth = options.depth
  if (options.text) args.text = true
  if (options.diff) args.diff = true

  const response = await sendCommand({
    command: 'dom',
    port: config.port,
    runtime: config.runtime,
    args,
  })

  if (!response.ok) {
    console.error(`Error: ${response.error}`)
    process.exit(1)
  }

  console.log(response.data)
}
