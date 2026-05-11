import { spawn } from 'node:child_process'
import { listTargets } from '../cdp/transport.js'
import { RuntimeType } from '../types.js'

const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000
const TAURI_LAUNCH_TIMEOUT_MS = 10 * 60_000
const POLL_INTERVAL_MS = 2_000

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
  try {
    const targets = await listTargets(port)
    return targets.length > 0
  } catch {
    // listTargets has its own try/catch per host, but socket-level errors
    // (ECONNRESET on a closing keep-alive socket) can leak through.
    return false
  }
}

export async function launch(
  command: string,
  port: number,
  cwd?: string,
  runtime?: RuntimeType,
): Promise<void> {
  if (await isRunning(port)) {
    return
  }

  // Tauri apps require a slow `cargo build`, frequently share the dev-server port
  // with a parallel browser-dev, and routinely orphan child processes on crash.
  // Auto-spawning them from agent-view's polling loop has caused EADDRINUSE and
  // killed dev sessions. Require manual start instead.
  if (runtime === RuntimeType.Tauri) {
    throw new Error(
      'Tauri apps must be started manually. Run your dev command in a separate terminal '
      + '(e.g. `npm run dev` or `cd src-tauri && cargo run`), then re-run agent-view. '
      + 'Auto-launch is disabled for Tauri because cargo builds are slow and dev-servers '
      + 'frequently conflict with parallel browser-dev on the same port.',
    )
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

  const timeout = DEFAULT_LAUNCH_TIMEOUT_MS
  const start = Date.now()
  while (Date.now() - start < timeout) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    if (await isRunning(port)) {
      return
    }
  }

  throw new Error(`Application did not start within ${timeout / 1000}s. Check your config.launch command.`)
}

/**
 * Installs a global guard that swallows async socket errors leaking from
 * chrome-remote-interface / Node http during CDP probing (ECONNRESET on a
 * closing keep-alive socket, ECONNREFUSED races, EPIPE). Anything else is
 * re-thrown so we don't hide real bugs.
 */
export function installCDPErrorGuard(): void {
  const isCDPProbeError = (err: unknown): boolean => {
    if (!err || typeof err !== 'object') return false
    const code = (err as { code?: string }).code
    if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EPIPE') return true
    const message = (err as { message?: string }).message ?? ''
    return /ECONNRESET|ECONNREFUSED|EPIPE/.test(message)
  }

  process.on('uncaughtException', (err) => {
    if (isCDPProbeError(err)) {
      if (process.env.AV_DEBUG_CONSOLE) {
        // eslint-disable-next-line no-console
        console.error('[av-debug] suppressed CDP probe error:', (err as Error).message)
      }
      return
    }
    throw err
  })

  process.on('unhandledRejection', (reason) => {
    if (isCDPProbeError(reason)) {
      if (process.env.AV_DEBUG_CONSOLE) {
        // eslint-disable-next-line no-console
        console.error('[av-debug] suppressed CDP probe rejection:', String(reason))
      }
      return
    }
    throw reason
  })
}
