import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type ClickOptions = {
  pos?: string
  filter?: string
  testid?: string
  selector?: string
  window?: string
  double?: boolean
  right?: boolean
}

export async function runClick(config: AgentViewConfig, refArg: string | undefined, options: ClickOptions): Promise<void> {
  const ways = [refArg, options.pos, options.filter, options.testid, options.selector].filter(f => f !== undefined)
  if (ways.length !== 1) {
    console.error('Usage: agent-view click <ref> | --filter <text> | --testid <id> | --selector <css> | --pos <x,y> — exactly one')
    process.exit(1)
  }

  const args: Record<string, unknown> = { testIdAttribute: config.testIdAttribute }

  if (options.testid !== undefined || options.selector !== undefined) {
    args.testid = options.testid
    args.selector = options.selector
  } else if (options.filter) {
    args.filter = options.filter
  } else if (options.pos) {
    const [x, y] = options.pos.split(',').map(Number)
    if (isNaN(x) || isNaN(y)) {
      console.error(`Invalid position: "${options.pos}". Expected format: x,y`)
      process.exit(1)
    }
    args.pos = { x, y }
  } else {
    const ref = parseInt(refArg!, 10)
    if (isNaN(ref)) {
      console.error(`Invalid ref: "${refArg}". Expected a number.`)
      process.exit(1)
    }
    args.ref = ref
  }

  if (options.window) args.window = options.window
  if (options.double) args.double = true
  if (options.right) args.right = true

  const response = await sendCommand({
    command: 'click',
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
