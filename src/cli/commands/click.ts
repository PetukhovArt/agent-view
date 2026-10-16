import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

export type TargetOptions = {
  pos?: string
  filter?: string
  testid?: string
  selector?: string
  window?: string
  scene?: string
}

type ClickOptions = TargetOptions & {
  double?: boolean
  right?: boolean
  modifiers?: string
}

/** The request args of the one target `command` was given; exits on none, several or a malformed one. */
export function targetArgs(command: string, config: AgentViewConfig, refArg: string | undefined, options: TargetOptions): Record<string, unknown> {
  const ways = [refArg, options.pos, options.filter, options.testid, options.selector, options.scene].filter(f => f !== undefined)
  if (ways.length !== 1) {
    console.error(`Usage: agent-view ${command} <ref> | --filter <text> | --testid <id> | --selector <css> | --pos <x,y> | --scene <object> — exactly one`)
    process.exit(1)
  }

  const args: Record<string, unknown> = { testIdAttribute: config.testIdAttribute }

  if (options.scene !== undefined) {
    args.scene = options.scene
  } else if (options.testid !== undefined || options.selector !== undefined) {
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
  return args
}

export async function sendPointer(config: AgentViewConfig, command: string, args: Record<string, unknown>): Promise<void> {
  const response = await sendCommand({
    command,
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

export async function runClick(config: AgentViewConfig, refArg: string | undefined, options: ClickOptions): Promise<void> {
  const args = targetArgs('click', config, refArg, options)
  if (options.double) args.double = true
  if (options.right) args.right = true
  if (options.modifiers) args.modifiers = options.modifiers
  await sendPointer(config, 'click', args)
}
