import { connect, type Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { ServerRequest, ServerResponse } from '../types.js'

const SERVER_PORT = 47922
const DELIMITER = '\n'

export async function sendCommand(request: ServerRequest): Promise<ServerResponse> {
  try {
    return await tryConnect(request)
  } catch {
    await startServer()
    return tryConnect(request)
  }
}

function tryConnect(request: ServerRequest): Promise<ServerResponse> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(SERVER_PORT, '127.0.0.1')
    let buffer = ''

    socket.on('connect', () => {
      // Send request with delimiter (no half-close)
      socket.write(JSON.stringify(request) + DELIMITER)
    })

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const delimIndex = buffer.indexOf(DELIMITER)
      if (delimIndex !== -1) {
        const message = buffer.slice(0, delimIndex)
        try {
          resolve(JSON.parse(message) as ServerResponse)
        } catch {
          reject(new Error('Invalid response from server'))
        }
        socket.destroy()
      }
    })

    socket.on('error', reject)
  })
}

async function startServer(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const serverEntryJs = join(__dirname, '..', 'server', 'index.js')
  const serverEntryTs = join(__dirname, '..', 'server', 'index.ts')

  // Detect dev (tsx) vs built (node) by checking if .ts source exists but .js doesn't
  const isDev = existsSync(serverEntryTs) && !existsSync(serverEntryJs)
  const cmd = isDev ? 'npx' : 'node'
  const args = isDev ? ['tsx', serverEntryTs] : [serverEntryJs]

  // Use agent-view project root as cwd so npx finds tsx
  const projectRoot = join(__dirname, '..', '..')

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: true,
    cwd: projectRoot,
    windowsHide: true,
  })
  child.unref()

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Server startup timeout (10s)'))
    }, 10_000)

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
