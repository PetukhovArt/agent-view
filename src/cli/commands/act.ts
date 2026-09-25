import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

/** `act replay` could not run at all (no script, no secret) — neither a pass nor a found bug. */
const EXIT_REPLAY_ERROR = 2

export async function runAct(config: AgentViewConfig, args: Record<string, unknown>): Promise<void> {
  const response = await sendCommand({
    command: 'act',
    port: config.port,
    runtime: config.runtime,
    args: { ...args, testIdAttribute: config.testIdAttribute, cwd: process.cwd() },
  })

  if (!response.ok) {
    console.error(response.error)
    process.exit(args.op === 'replay' ? EXIT_REPLAY_ERROR : 1)
  }
  console.log(response.data)
  if (response.exitCode) process.exit(response.exitCode)
}
