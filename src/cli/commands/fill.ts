import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type FillOptions = {
  filter?: string
  window?: string
}

export async function runFill(config: AgentViewConfig, refOrValue: string, valueArg: string | undefined, options: FillOptions): Promise<void> {
  const args: Record<string, unknown> = {}

  if (options.filter) {
    // fill --filter "Label" "value" → refOrValue is the value
    args.filter = options.filter
    args.value = refOrValue
  } else {
    // fill <ref> <value>
    const ref = parseInt(refOrValue, 10)
    if (isNaN(ref)) {
      console.error(`Invalid ref: "${refOrValue}". Expected a number. Or use --filter.`)
      process.exit(1)
    }
    if (!valueArg) {
      console.error('Usage: agent-view fill <ref> <value> | agent-view fill --filter <text> <value>')
      process.exit(1)
    }
    args.ref = ref
    args.value = valueArg
  }

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
