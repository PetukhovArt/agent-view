import { spawn } from 'node:child_process'
import { listTargets } from '../cdp/transport.js'

const LAUNCH_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 1_000

export async function isRunning(port: number): Promise<boolean> {
  const targets = await listTargets(port)
  return targets.length > 0
}

export async function launch(command: string, port: number): Promise<void> {
  if (await isRunning(port)) {
    return
  }

  const child = spawn(command, {
    shell: true,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  const start = Date.now()
  while (Date.now() - start < LAUNCH_TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    if (await isRunning(port)) {
      return
    }
  }

  throw new Error(`Application did not start within ${LAUNCH_TIMEOUT_MS / 1000}s. Check your config.launch command.`)
}
