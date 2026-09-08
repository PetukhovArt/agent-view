import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type CoverageOptions = {
  clear?: boolean
  filter?: string
  file?: string
  all?: boolean
  count?: boolean
  maxLines?: number
  window?: string
  target?: string
}

export async function runCoverage(config: AgentViewConfig, options: CoverageOptions): Promise<void> {
  const args: Record<string, unknown> = {}
  if (options.clear) args.clear = true
  if (options.filter) args.filter = options.filter
  if (options.file) args.file = options.file
  if (options.all) args.all = true
  if (options.count) args.count = true
  if (options.maxLines !== undefined) args.maxLines = options.maxLines
  if (options.window) args.window = options.window
  if (options.target) args.target = options.target

  const response = await sendCommand({
    command: 'coverage',
    port: config.port,
    runtime: config.runtime,
    args,
  })

  if (response.ok) {
    console.log(response.data)
  } else {
    console.error(response.error)
    process.exit(1)
  }
}
