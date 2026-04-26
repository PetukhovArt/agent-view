import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

export type DragOptions = {
  from?: string
  to?: string
  fromPos?: string
  toPos?: string
  steps?: string
  button?: string
  holdMs?: string
  window?: string
}

export async function runDrag(config: AgentViewConfig, options: DragOptions): Promise<void> {
  const args: Record<string, unknown> = {}

  const fromOk = applyEndpoint(args, 'from', options.from, options.fromPos)
  if (!fromOk) process.exit(1)
  const toOk = applyEndpoint(args, 'to', options.to, options.toPos)
  if (!toOk) process.exit(1)

  if (options.steps !== undefined) {
    const n = parseInt(options.steps, 10)
    if (isNaN(n) || n < 0) {
      console.error(`Invalid --steps: "${options.steps}"`)
      process.exit(1)
    }
    args.steps = n
  }

  if (options.button !== undefined) {
    args.button = options.button
  }

  if (options.holdMs !== undefined) {
    const n = parseInt(options.holdMs, 10)
    if (isNaN(n) || n < 0) {
      console.error(`Invalid --hold-ms: "${options.holdMs}"`)
      process.exit(1)
    }
    args.holdMs = n
  }

  if (options.window) args.window = options.window

  const response = await sendCommand({
    command: 'drag',
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

function applyEndpoint(
  args: Record<string, unknown>,
  side: 'from' | 'to',
  ref: string | undefined,
  pos: string | undefined,
): boolean {
  if (ref !== undefined && pos !== undefined) {
    console.error(`--${side} and --${side}-pos are mutually exclusive`)
    return false
  }
  if (ref !== undefined) {
    const n = parseInt(ref, 10)
    if (isNaN(n)) {
      console.error(`Invalid --${side} ref: "${ref}"`)
      return false
    }
    args[`${side}Ref`] = n
    return true
  }
  if (pos !== undefined) {
    const [x, y] = pos.split(',').map(Number)
    if (isNaN(x) || isNaN(y)) {
      console.error(`Invalid --${side}-pos: "${pos}". Expected format: x,y`)
      return false
    }
    args[`${side}X`] = x
    args[`${side}Y`] = y
    return true
  }
  console.error(`drag requires --${side} <ref> or --${side}-pos <x,y>`)
  return false
}
