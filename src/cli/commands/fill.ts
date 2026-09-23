import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type FillOptions = {
  filter?: string
  testid?: string
  selector?: string
  window?: string
}

export async function runFill(config: AgentViewConfig, refOrValue: string, valueArg: string | undefined, options: FillOptions): Promise<void> {
  const args: Record<string, unknown> = { testIdAttribute: config.testIdAttribute }

  const finders = [options.filter, options.testid, options.selector].filter(f => f !== undefined).length
  if (finders > 1 || (finders === 1 && valueArg !== undefined)) {
    console.error('Address the input one way: <ref>, --filter, --testid or --selector')
    process.exit(1)
  }

  if (finders === 1) {
    // fill --filter "Label" "value" → refOrValue is the value
    args.filter = options.filter
    args.testid = options.testid
    args.selector = options.selector
    args.value = refOrValue
  } else {
    // fill <ref> <value>
    const ref = parseInt(refOrValue, 10)
    if (isNaN(ref)) {
      console.error(`Invalid ref: "${refOrValue}". Expected a number. Or use --filter, --testid or --selector.`)
      process.exit(1)
    }
    if (!valueArg) {
      console.error('Usage: agent-view fill <ref> <value> | agent-view fill --filter <text> | --testid <id> | --selector <css> <value>')
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
