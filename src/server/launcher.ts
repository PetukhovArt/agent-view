import { spawn } from 'node:child_process'
import { listTargets } from '../cdp/transport.js'

const LAUNCH_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 1_000

// Commands that are .cmd scripts on Windows and need explicit extension
// when spawned without shell
const WIN_CMD_EXECUTABLES = new Set(['npm', 'npx', 'pnpm', 'yarn', 'ng', 'vite', 'tsc'])

export function parseCommand(cmd: string): [string, string[]] {
  const parts = cmd.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  const cleaned = parts.map(p => p.replace(/^["']|["']$/g, ''))
  let exe = cleaned[0]
  if (process.platform === 'win32' && WIN_CMD_EXECUTABLES.has(exe)) {
    exe = `${exe}.cmd`
  }
  return [exe, cleaned.slice(1)]
}

export async function isRunning(port: number): Promise<boolean> {
  const targets = await listTargets(port)
  return targets.length > 0
}

export async function launch(command: string, port: number, cwd?: string): Promise<void> {
  if (await isRunning(port)) {
    return
  }

  const [exe, args] = parseCommand(command)
  const child = spawn(exe, args, {
    shell: false,
    detached: true,
    stdio: 'ignore',
    cwd,
    windowsHide: true,
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
