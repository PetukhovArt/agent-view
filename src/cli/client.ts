import { connect, type Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import type { ServerRequest, ServerResponse } from '../types.js'

const SERVER_PORT = 47922

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
    let data = ''

    socket.on('connect', () => {
      socket.end(JSON.stringify(request))
    })

    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString()
    })

    socket.on('end', () => {
      try {
        resolve(JSON.parse(data) as ServerResponse)
      } catch {
        reject(new Error('Invalid response from server'))
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

  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: true,
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
