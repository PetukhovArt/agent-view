/**
 * Pure-CRI diagnostic. No AgentViewServer, no agent-view code.
 * Spawns electron, attaches via chrome-remote-interface, tries BOTH subscription
 * forms, evaluates console.log inside the page, prints whatever arrives.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error no types
import CDP from 'chrome-remote-interface'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = 19222

function spawnElectron(): ChildProcess {
  const appDir = join(__dirname, 'app')
  const exeName = readFileSync(join(appDir, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()
  const bin = join(appDir, 'node_modules', 'electron', 'dist', exeName)
  return spawn(bin, ['main.js', `--remote-debugging-port=${PORT}`], { cwd: appDir, stdio: 'ignore' })
}

async function waitCDP(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return } catch { /* */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('CDP unreachable')
}

async function main(): Promise<void> {
  const proc = spawnElectron()
  await new Promise(r => setTimeout(r, 2000))
  await waitCDP()
  console.log('[diag] electron up')

  // List targets
  const targets = await CDP.List({ host: '127.0.0.1', port: PORT })
  console.log('[diag] targets:', targets.map((t: { id: string; type: string }) => `${t.type}:${t.id.slice(0, 8)}`).join(', '))
  const page = targets.find((t: { type: string }) => t.type === 'page')
  if (!page) throw new Error('no page target')

  const client = await CDP({ host: '127.0.0.1', port: PORT, target: page.id })
  console.log('[diag] CDP client connected')
  console.log('[diag] client keys:', Object.keys(client).filter(k => /^[A-Z]/.test(k)).join(', '))
  console.log('[diag] client has .on?', typeof client.on)
  console.log('[diag] Runtime.consoleAPICalled type:', typeof client.Runtime?.consoleAPICalled)

  // Form 1: client.on('Runtime.consoleAPICalled', cb)
  let formA = 0, formB = 0, formC = 0
  client.on('Runtime.consoleAPICalled', (params: { type: string }) => {
    formA++
    console.log(`  [via client.on] consoleAPICalled type=${params.type}`)
  })
  client.on('Log.entryAdded', (params: { entry: { text: string } }) => {
    console.log(`  [via client.on] Log.entryAdded: ${params.entry.text?.slice(0, 80)}`)
  })

  // Form 2: client.Runtime.consoleAPICalled(cb)
  if (typeof client.Runtime.consoleAPICalled === 'function') {
    client.Runtime.consoleAPICalled((params: { type: string }) => {
      formB++
      console.log(`  [via client.Runtime] consoleAPICalled type=${params.type}`)
    })
  }

  // Form 3: client.on('event') (lowercase shorthand sometimes used)
  client.on('event', (msg: { method: string }) => {
    if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Log.entryAdded') {
      formC++
      console.log(`  [via client.on('event')] method=${msg.method}`)
    }
  })

  await client.Runtime.enable()
  await client.Log.enable()
  console.log('[diag] Runtime+Log enabled, evaluating console.log...')

  await client.Runtime.evaluate({ expression: `console.log('DIAG_HELLO_FROM_PAGE')` })
  await client.Runtime.evaluate({ expression: `console.warn('DIAG_WARN')` })
  await client.Runtime.evaluate({ expression: `console.error('DIAG_ERROR')` })
  // Also create a log entry via fake fetch failure to test Log domain
  await client.Runtime.evaluate({ expression: `fetch('http://127.0.0.1:1/nope').catch(() => {})` })

  await new Promise(r => setTimeout(r, 1500))

  console.log(`\n[diag] event counts:  client.on=${formA}  client.Runtime=${formB}  client.on('event')=${formC}`)
  await client.close()
  proc.kill()
}

main().catch((err: unknown) => {
  console.error('[diag] FATAL:', err instanceof Error ? err.stack : err)
  process.exit(1)
})
