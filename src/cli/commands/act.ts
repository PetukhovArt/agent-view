import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

/** `act replay` could not run at all (no script, no secret) — neither a pass nor a found bug. */
const EXIT_REPLAY_ERROR = 2

export async function runAct(config: AgentViewConfig, args: Record<string, unknown>): Promise<void> {
  const response = await sendCommand({
    command: 'act',
    port: config.port,
    runtime: config.runtime,
    engine: config.webgl?.engine,
    args: { ...args, testIdAttribute: config.testIdAttribute, cwd: process.cwd() },
  }, args.op === 'replay' ? { timeoutMs: 0 } : {})  // a replay outlasts any fixed backstop; the server bounds it by its scripts' timeouts

  if (!response.ok) {
    console.error(response.error)
    process.exit(args.op === 'replay' ? EXIT_REPLAY_ERROR : 1)
  }
  console.log(response.data)
  if (response.exitCode) process.exit(response.exitCode)
}
