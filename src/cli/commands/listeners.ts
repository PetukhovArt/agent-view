import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type ListenersOptions = {
  ref?: string
  filter?: string
  selector?: string
  depth?: number
  window?: string
}

export async function runListeners(config: AgentViewConfig, options: ListenersOptions): Promise<void> {
  const args: Record<string, unknown> = {}
  if (options.selector) args.selector = options.selector
  if (options.filter) args.filter = options.filter
  if (options.ref !== undefined) {
    const ref = parseInt(options.ref, 10)
    if (isNaN(ref)) {
      console.error(`Invalid ref: "${options.ref}". Expected a number.`)
      process.exit(1)
    }
    args.ref = ref
  }
  if (options.depth !== undefined) args.depth = options.depth
  if (options.window) args.window = options.window

  const response = await sendCommand({
    command: 'listeners',
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
