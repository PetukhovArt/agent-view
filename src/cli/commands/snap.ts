import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type SnapOptions = {
  window?: string
  filter?: string
  depth?: number
  scale?: number
}

export async function runSnap(config: AgentViewConfig, options: SnapOptions): Promise<void> {
  const args: Record<string, unknown> = {}
  if (options.window) args.window = options.window
  if (options.filter) args.filter = options.filter
  if (options.depth !== undefined) args.depth = options.depth
  if (options.scale !== undefined) args.scale = options.scale

  const response = await sendCommand({
    command: 'snap',
    port: config.port,
    runtime: config.runtime,
    engine: config.webgl?.engine,
    args,
  })

  if (response.ok) {
    console.log(response.data)
  } else {
    console.error(response.error)
    process.exit(1)
  }
}
