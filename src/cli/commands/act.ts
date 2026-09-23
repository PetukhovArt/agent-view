import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

export async function runAct(config: AgentViewConfig, args: Record<string, unknown>): Promise<void> {
  const response = await sendCommand({
    command: 'act',
    port: config.port,
    runtime: config.runtime,
    args: { ...args, testIdAttribute: config.testIdAttribute },
  })

  if (!response.ok) {
    console.error(response.error)
    process.exit(1)
  }
  console.log(response.data)
  if (args.op === 'replay') {
    const verdict = String(response.data)
    process.exit(verdict.startsWith('DONE') ? 0 : verdict.startsWith('STALE') ? 3 : 1)
  }
}
