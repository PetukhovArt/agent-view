import { createInterface } from 'node:readline'
import { sendCommand } from '../client.js'
import { ServerErrorCode, type PortConflictData, type ServerResponse } from '../../types.js'
import type { AgentViewConfig } from '../../config/types.js'

function sendLaunch(config: AgentViewConfig): Promise<ServerResponse> {
  return sendCommand({
    command: 'launch',
    port: config.port,
    runtime: config.runtime,
    args: { launch: config.launch, cwd: process.cwd() },
  })
}

function promptRetry(): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    rl.question(
      'Close the conflicting process or start the app manually, then press Enter to retry (or type "q" + Enter to abort): ',
      (answer) => {
        rl.close()
        resolve(answer.trim().toLowerCase() !== 'q')
      },
    )
  })
}

export async function runLaunch(config: AgentViewConfig): Promise<void> {
  if (!config.launch) {
    console.error('No launch command configured. Add "launch" to agent-view.config.json.')
    process.exit(1)
  }

  let response = await sendLaunch(config)

  while (!response.ok && response.code === ServerErrorCode.PortConflict) {
    const conflict = response.data as PortConflictData
    const who = conflict.processName && conflict.pid
      ? `${conflict.processName} (PID ${conflict.pid})`
      : conflict.pid
        ? `PID ${conflict.pid}`
        : 'unknown process'
    console.error(`Port ${conflict.port} is occupied by ${who} and does not expose CDP.`)
    console.error('Options: (1) close that process so agent-view can auto-launch the app, or (2) start the app manually.')

    if (!process.stdin.isTTY) {
      process.exit(1)
    }
    const retry = await promptRetry()
    if (!retry) process.exit(1)
    response = await sendLaunch(config)
  }

  if (response.ok) {
    console.log(response.data)
  } else {
    console.error(response.error)
    process.exit(1)
  }
}
