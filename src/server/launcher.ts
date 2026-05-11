import { spawn, execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { promisify } from 'node:util'
import { listTargets } from '../cdp/transport.js'
import { RuntimeType, type PortConflictData } from '../types.js'

const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000
const TAURI_LAUNCH_TIMEOUT_MS = 10 * 60_000
const POLL_INTERVAL_MS = 2_000
const PORT_PROBE_TIMEOUT_MS = 500

const execFileAsync = promisify(execFile)

const WIN_CMD_EXECUTABLES = new Set(['npm', 'npx', 'pnpm', 'yarn', 'ng', 'vite', 'tsc'])

export class PortConflictError extends Error {
  readonly conflict: PortConflictData
  constructor(conflict: PortConflictData) {
    const who = conflict.processName && conflict.pid
      ? `${conflict.processName} (PID ${conflict.pid})`
      : conflict.pid
        ? `PID ${conflict.pid}`
        : 'an unknown process'
    super(
      `Port ${conflict.port} is occupied by ${who}, but it does not expose CDP. `
      + `Either stop that process to let agent-view auto-launch the app, or start the app manually so it listens on port ${conflict.port}.`,
    )
    this.name = 'PortConflictError'
    this.conflict = conflict
  }
}

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
    return false
  }
}

function probePortOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (open: boolean): void => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}

async function resolvePortOwner(port: number): Promise<{ pid?: number, processName?: string }> {
  try {
    if (process.platform === 'win32') {
      const ps = `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; \"$($c.OwningProcess)|$($p.ProcessName)\" }`
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 3000 })
      const line = stdout.trim()
      if (!line) return {}
      const [pidStr, name] = line.split('|')
      const pid = Number(pidStr)
      return { pid: Number.isFinite(pid) ? pid : undefined, processName: name || undefined }
    }
    const { stdout } = await execFileAsync('lsof', ['-iTCP:' + port, '-sTCP:LISTEN', '-Fpc', '-n', '-P'], { timeout: 3000 })
    let pid: number | undefined
    let processName: string | undefined
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1))
      else if (line.startsWith('c')) processName = line.slice(1)
    }
    return { pid, processName }
  } catch {
    return {}
  }
}

export async function detectPortConflict(port: number): Promise<PortConflictData | null> {
  if (await isRunning(port)) return null
  const open = await probePortOpen(port)
  if (!open) return null
  const owner = await resolvePortOwner(port)
  return { port, ...owner }
}

export async function launch(
  command: string,
  port: number,
  cwd?: string,
  runtime?: RuntimeType,
): Promise<void> {
  if (await isRunning(port)) return

  const open = await probePortOpen(port)
  if (open) {
    const owner = await resolvePortOwner(port)
    throw new PortConflictError({ port, ...owner })
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

  const timeout = runtime === RuntimeType.Tauri ? TAURI_LAUNCH_TIMEOUT_MS : DEFAULT_LAUNCH_TIMEOUT_MS
  const start = Date.now()
  while (Date.now() - start < timeout) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
    if (await isRunning(port)) return
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
