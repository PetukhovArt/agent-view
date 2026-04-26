import { connect, type Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { AgentViewConfig } from '../../config/types.js'
import { WATCH_MIN_INTERVAL_MS, type WatchFrame, type JsonPatchOp } from '../../inspectors/watch/types.js'

const SERVER_PORT = 47922
const DELIMITER = '\n'
const TOKEN_PATH = join(homedir(), '.agent-view', 'token')

export type WatchOptions = {
  interval?: string
  duration?: string
  maxChanges?: string
  until?: string
  json?: boolean
  target?: string
  window?: string
}

export async function runWatch(
  config: AgentViewConfig,
  expression: string,
  options: WatchOptions,
): Promise<void> {
  if (!expression) {
    console.error('watch requires an expression')
    process.exit(1)
  }

  const intervalMs = parsePosInt(options.interval, 250, '--interval')
  const durationS = parsePosInt(options.duration, 30, '--duration')
  const maxChanges = parsePosInt(options.maxChanges, 10, '--max-changes')

  if (maxChanges <= 0) {
    console.error('--max-changes must be > 0')
    process.exit(2)
  }

  let effectiveInterval = intervalMs
  if (effectiveInterval < WATCH_MIN_INTERVAL_MS) {
    process.stderr.write(`warning: --interval ${effectiveInterval} clamped to ${WATCH_MIN_INTERVAL_MS}ms\n`)
    effectiveInterval = WATCH_MIN_INTERVAL_MS
  }

  const args = {
    expression,
    intervalMs: effectiveInterval,
    durationS,
    maxChanges,
    until: options.until,
    target: options.target,
    window: options.window,
    cwd: process.cwd(),
  }

  const request = {
    command: 'watch',
    port: config.port,
    runtime: config.runtime,
    args,
    token: readToken(),
  }

  await runStream(request, options)
}

async function runStream(request: object, options: WatchOptions): Promise<void> {
  try {
    await openAndStream(request, options)
  } catch (err) {
    if (err instanceof ConnRefused) {
      await startServer()
      const newRequest = { ...(request as Record<string, unknown>), token: readToken() }
      await openAndStream(newRequest, options)
      return
    }
    throw err
  }
}

class ConnRefused extends Error {}

function openAndStream(request: object, options: WatchOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(SERVER_PORT, '127.0.0.1')
    let buffer = ''
    let exitCode = 0
    let stopReceived = false
    let sigintReceived = false

    const onSigint = (): void => {
      sigintReceived = true
      socket.end()
      // Don't exit immediately — wait for stop frame to flush stdout.
      // Fallback after 1s.
      setTimeout(() => process.exit(130), 1000).unref()
    }
    process.on('SIGINT', onSigint)

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + DELIMITER)
    })

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      let idx = buffer.indexOf(DELIMITER)
      while (idx !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        idx = buffer.indexOf(DELIMITER)
        if (!line) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          process.stderr.write(`warning: malformed frame from server: ${line}\n`)
          continue
        }
        // Server-side validation error comes as ServerResponse with `ok` field.
        if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
          const r = parsed as { ok?: boolean; error?: string }
          if (r.ok === false) {
            process.stderr.write(`Error: ${r.error ?? 'unknown'}\n`)
            exitCode = 1
            socket.destroy()
            return
          }
        }
        const frame = parsed as WatchFrame
        printFrame(frame, options)
        if (frame.type === 'stop') {
          stopReceived = true
          if (!frame.ok) exitCode = 1
        }
      }
    })

    socket.on('close', () => {
      process.off('SIGINT', onSigint)
      if (!stopReceived && exitCode === 0) {
        // Server closed without a stop frame → unusual
        process.stderr.write('warning: server closed connection without stop frame\n')
        exitCode = 1
      }
      if (sigintReceived && exitCode === 0) exitCode = 130
      resolve()
      process.exit(exitCode)
    })

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
        reject(new ConnRefused(err.message))
        return
      }
      reject(err)
    })
  })
}

function printFrame(frame: WatchFrame, options: WatchOptions): void {
  if (options.json) {
    process.stdout.write(JSON.stringify(frame) + '\n')
    return
  }

  const ts = `[${frame.ts}]`
  switch (frame.type) {
    case 'init': {
      process.stdout.write(`${ts} init ${stringify(frame.value)}\n`)
      return
    }
    case 'diff': {
      for (const op of frame.ops) process.stdout.write(`${ts} ${formatOp(op)}\n`)
      return
    }
    case 'error': {
      process.stdout.write(`${ts} error ${frame.message}\n`)
      return
    }
    case 'stop': {
      const cnt = frame.count !== undefined ? ` count=${frame.count}` : ''
      process.stdout.write(`${ts} stop reason=${frame.reason}${cnt}\n`)
      return
    }
  }
}

function formatOp(op: JsonPatchOp): string {
  const path = op.path === '' ? '/' : op.path
  switch (op.op) {
    case 'replace': return `replace ${path} → ${stringify(op.value)}`
    case 'add': return `add ${path} ${stringify(op.value)}`
    case 'remove': return `remove ${path}`
    case 'move': return `move ${op.from} → ${path}`
    case 'copy': return `copy ${op.from} → ${path}`
    case 'test': return `test ${path} ${stringify(op.value)}`
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function parsePosInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Invalid ${name}: "${raw}"`)
    process.exit(2)
  }
  return Math.floor(n)
}

function readToken(): string {
  try {
    return readFileSync(TOKEN_PATH, 'utf-8').trim()
  } catch {
    return ''
  }
}

async function startServer(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const serverEntryJs = join(__dirname, '..', '..', 'server', 'index.js')
  const serverEntryTs = join(__dirname, '..', '..', 'server', 'index.ts')

  const isDev = existsSync(serverEntryTs) && !existsSync(serverEntryJs)
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const cmd = isDev ? npx : 'node'
  const args = isDev ? ['tsx', serverEntryTs] : [serverEntryJs]
  const projectRoot = join(__dirname, '..', '..', '..')

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
    cwd: projectRoot,
    windowsHide: true,
  })
  child.unref()

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timeout (10s)')), 10_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('READY')) {
        clearTimeout(timeout)
        resolve()
      }
    })
    child.on('error', (err: Error) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}
