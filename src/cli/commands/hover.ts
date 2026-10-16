import type { AgentViewConfig } from '../../config/types.js'
import { sendPointer, targetArgs, type TargetOptions } from './click.js'

export async function runHover(config: AgentViewConfig, refArg: string | undefined, options: TargetOptions & { holdMs?: string }): Promise<void> {
  const args = targetArgs('hover', config, refArg, options)
  if (options.holdMs !== undefined) args.holdMs = options.holdMs
  await sendPointer(config, 'hover', args)
}
