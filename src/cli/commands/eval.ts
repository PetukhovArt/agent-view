import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

export type EvalOptions = {
  target?: string
  window?: string
  await?: boolean
  json?: boolean
}

export async function runEval(
  config: AgentViewConfig,
  expression: string,
  options: EvalOptions,
): Promise<void> {
  if (!expression) {
    console.error('eval requires an expression')
    process.exit(1)
  }

  const response = await sendCommand({
    command: 'eval',
    port: config.port,
    runtime: config.runtime,
    args: {
      expression,
      target: options.target,
      window: options.window,
      await: options.await,
      json: options.json,
      cwd: process.cwd(),
    },
  })

  if (!response.ok) {
    console.error(`Error: ${response.error}`)
    process.exit(1)
  }

  const data = response.data as { target: { id: string; type: string }; result: string }
  if (process.stdout.isTTY) {
    console.log(`# ${data.target.type}:${data.target.id.slice(0, 8)}`)
  }
  console.log(data.result)
}
