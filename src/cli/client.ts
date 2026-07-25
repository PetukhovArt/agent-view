import { connect, type Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { ServerRequest, ServerResponse } from '../types.js'

const SERVER_PORT = 47922
const DELIMITER = '\n'
const TOKEN_PATH = join(homedir(), '.agent-view', 'token')
/** Backstop above the server-side deadline: the CLI must always exit, even against a wedged server. */
const CLIENT_DEADLINE_MS = 120_000

export type SendOptions = {
  /** Override the client-side deadline. `0` disables it (used by `launch`, which blocks for minutes). */
  timeoutMs?: number
}

export function readToken(): string {
  try {
    return readFileSync(TOKEN_PATH, 'utf-8').trim()
  } catch {
    return ''
  }
}

export async function sendCommand(request: ServerRequest, options: SendOptions = {}): Promise<ServerResponse> {
  const timeoutMs = options.timeoutMs ?? CLIENT_DEADLINE_MS
  let response: ServerResponse
  try {
    response = await tryConnect({ ...request, token: readToken() }, timeoutMs)
  } catch (err) {
    if (err instanceof ServerTimeoutError) throw err
    await startServer()
    return tryConnect({ ...request, token: readToken() }, timeoutMs)
  }

  if (isUnauthorized(response) && request.command !== 'stop') {
    // The running server predates the current token file (crashed restart, cleared
    // $HOME). Its token is unknowable, so replace it rather than fail every call.
    await tryConnect({ command: 'stop', port: 0, runtime: request.runtime, args: {}, token: '' }, 5_000)
      .catch(() => { /* best effort */ })
    await waitForPortFree()
    await startServer()
    return tryConnect({ ...request, token: readToken() }, timeoutMs)
  }

  return response
}

function isUnauthorized(response: ServerResponse): boolean {
  return !response.ok && response.error === 'Unauthorized'
}

async function waitForPortFree(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const inUse = await new Promise<boolean>((resolve) => {
      const probe = connect(SERVER_PORT, '127.0.0.1')
      probe.on('connect', () => { probe.destroy(); resolve(true) })
      probe.on('error', () => resolve(false))
    })
    if (!inUse) return
    await new Promise(r => setTimeout(r, 100))
  }
}

export class ServerTimeoutError extends Error {}

function tryConnect(request: ServerRequest, timeoutMs: number): Promise<ServerResponse> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(SERVER_PORT, '127.0.0.1')
    let buffer = ''

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          socket.destroy()
          reject(new ServerTimeoutError(
            `agent-view server did not answer "${request.command}" within ${Math.round(timeoutMs / 1000)}s. `
            + 'Run `agent-view stop` to reset the server, then retry.',
          ))
        }, timeoutMs)
      : undefined

    const settle = (fn: () => void): void => {
      if (timer) clearTimeout(timer)
      fn()
    }

    socket.on('connect', () => {
      // Send request with delimiter (no half-close)
      socket.write(JSON.stringify(request) + DELIMITER)
    })

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const delimIndex = buffer.indexOf(DELIMITER)
      if (delimIndex !== -1) {
        const message = buffer.slice(0, delimIndex)
        settle(() => {
          try {
            resolve(JSON.parse(message) as ServerResponse)
          } catch {
            reject(new Error('Invalid response from server'))
          }
        })
        socket.destroy()
      }
    })

    socket.on('error', (err) => settle(() => reject(err)))
  })
}

function resolveTsxCli(): string {
  return createRequire(import.meta.url).resolve('tsx/cli')
}

/** Spawns the lazy server and resolves when it prints READY. Shared with the streaming (`watch`) client. */
export async function startServer(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const serverEntryJs = join(__dirname, '..', 'server', 'index.js')
  const serverEntryTs = join(__dirname, '..', 'server', 'index.ts')

  // Detect dev (tsx) vs built (node) by checking if .ts source exists but .js doesn't
  const isDev = existsSync(serverEntryTs) && !existsSync(serverEntryJs)
  // Dev mode runs tsx's CLI entry through this same node binary: spawning `npx.cmd`
  // with shell:false is rejected with EINVAL by Node >= 20 on Windows.
  const cmd = process.execPath
  const args = isDev ? [resolveTsxCli(), serverEntryTs] : [serverEntryJs]

  // Resolve tsx relative to the agent-view install, not the caller's project
  const projectRoot = join(__dirname, '..', '..')

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: false,
    cwd: projectRoot,
    windowsHide: true,
  })
  child.unref()

  return new Promise((resolve, reject) => {
    // The READY pipe is the parent's only handle on the detached server. Left attached
    // it keeps the CLI's event loop alive forever — the command prints its result and
    // then hangs. Release it on every exit path.
    const release = (): void => {
      clearTimeout(timeout)
      child.stdout?.removeAllListeners('data')
      child.stdout?.destroy()
      child.removeAllListeners('error')
    }

    const timeout = setTimeout(() => {
      release()
      reject(new Error('Server startup timeout (10s)'))
    }, 10_000)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('READY')) {
        release()
        resolve()
      }
    })

    child.on('error', (err: Error) => {
      release()
      reject(err)
    })
  })
}
