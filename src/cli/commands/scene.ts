import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type SceneOptions = {
  window?: string
  filter?: string
  depth?: number
  verbose?: boolean
  diff?: boolean
  compact?: boolean
  goto?: string
}

export async function runScene(config: AgentViewConfig, options: SceneOptions): Promise<void> {
  const args: Record<string, unknown> = {}
  if (options.window) args.window = options.window
  if (options.filter) args.filter = options.filter
  if (options.depth !== undefined) args.depth = options.depth
  if (options.verbose) args.verbose = true
  if (options.diff) args.diff = true
  if (options.compact) args.compact = true
  if (options.goto !== undefined) args.goto = options.goto

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
