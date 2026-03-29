import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type FillOptions = {
  window?: string
}

export async function runFill(config: AgentViewConfig, refArg: string, valueArg: string, options: FillOptions): Promise<void> {
  const ref = parseInt(refArg, 10)
  if (isNaN(ref)) {
    console.error(`Invalid ref: "${refArg}". Expected a number.`)
    process.exit(1)
  }

  const args: Record<string, unknown> = { ref, value: valueArg }
  if (options.window) args.window = options.window

  const response = await sendCommand({
    command: 'fill',
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
