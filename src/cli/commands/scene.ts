import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type SceneOptions = {
  window?: string
  filter?: string
  depth?: number
  verbose?: boolean
  diff?: boolean
}

export async function runScene(config: AgentViewConfig, options: SceneOptions): Promise<void> {
  const args: Record<string, unknown> = {}
  if (options.window) args.window = options.window
  if (options.filter) args.filter = options.filter
  if (options.depth !== undefined) args.depth = options.depth
  if (options.verbose) args.verbose = true
  if (options.diff) args.diff = true

  const response = await sendCommand({
    command: 'scene',
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
