import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type ClickOptions = {
  pos?: string
  window?: string
}

export async function runClick(config: AgentViewConfig, refArg: string | undefined, options: ClickOptions): Promise<void> {
  if (!refArg && !options.pos) {
    console.error('Usage: agent-view click <ref> or agent-view click --pos <x,y>')
    process.exit(1)
  }

  const args: Record<string, unknown> = {}

  if (options.pos) {
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
