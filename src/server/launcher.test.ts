import { createServer, type Server } from 'node:net'
import { describe, it, expect } from 'vitest'
import { parseCommand, launch, PortConflictError, detectPortConflict } from './launcher.js'

describe('parseCommand', () => {
  it('splits simple command', () => {
    const [exe, args] = parseCommand('node server.js')
    expect(exe).toBe('node')
    expect(args).toEqual(['server.js'])
  })

  it('handles quoted arguments', () => {
    const [exe, args] = parseCommand('echo "hello world"')
    expect(exe).toBe('echo')
    expect(args).toEqual(['hello world'])
  })

  it('handles single-quoted arguments', () => {
    const [exe, args] = parseCommand("echo 'hello world'")
    expect(exe).toBe('echo')
    expect(args).toEqual(['hello world'])
  })

  it('adds .cmd suffix for npm on Windows', () => {
    const [exe] = parseCommand('npm run dev')
    if (process.platform === 'win32') {
      expect(exe).toBe('npm.cmd')
    } else {
      expect(exe).toBe('npm')
    }
  })

  it('adds .cmd suffix for pnpm on Windows', () => {
    const [exe] = parseCommand('pnpm run dev')
    if (process.platform === 'win32') {
      expect(exe).toBe('pnpm.cmd')
    } else {
      expect(exe).toBe('pnpm')
    }
  })

  it('returns empty args for single-word command', () => {
    const [exe, args] = parseCommand('electron')
    expect(args).toEqual([])
  })
})

function listenOnPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Reply with HTTP 404 so chrome-remote-interface's GET /json/list fails fast
    // instead of hanging — we're simulating "port held by non-CDP process".
    const srv = createServer((sock) => {
      sock.once('data', () => {
        sock.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
      })
    })
    srv.once('error', reject)
    srv.listen(port, '127.0.0.1', () => resolve(srv))
  })
}

describe('detectPortConflict', () => {
  it('returns null when nothing is listening on the port', async () => {
    expect(await detectPortConflict(47998)).toBeNull()
  })

  it('reports a conflict when a non-CDP process holds the port', async () => {
    const port = 47997
    const srv = await listenOnPort(port)
    try {
      const conflict = await detectPortConflict(port)
      expect(conflict).not.toBeNull()
      expect(conflict?.port).toBe(port)
    } finally {
      await new Promise<void>(r => srv.close(() => r()))
    }
  })
})

describe('launch', () => {
  it('throws PortConflictError when port is held by non-CDP process', async () => {
    const port = 47996
    const srv = await listenOnPort(port)
    try {
      await expect(launch('node noop.js', port)).rejects.toBeInstanceOf(PortConflictError)
    } finally {
      await new Promise<void>(r => srv.close(() => r()))
    }
  })
})
