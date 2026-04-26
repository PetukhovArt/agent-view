import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

export type TargetsOptions = {
  type?: string
  json?: boolean
}

export async function runTargets(config: AgentViewConfig, options: TargetsOptions): Promise<void> {
  const types = options.type
    ? options.type.split(',').map(s => s.trim()).filter(Boolean)
    : undefined

  const response = await sendCommand({
    command: 'targets',
    port: config.port,
    runtime: config.runtime,
    args: { types },
  })

  if (!response.ok) {
    console.error(`Error: ${response.error}`)
    process.exit(1)
  }

  if (options.json) {
    console.log(JSON.stringify(response.data, null, 2))
    return
  }

  const data = response.data as { targets: Array<{ id: string; type: string; title: string; url: string }> }
  if (!data.targets.length) {
    console.log('(no targets)')
    return
  }
  for (const t of data.targets) {
    const title = t.title || '(untitled)'
    console.log(`${t.type.padEnd(15)} ${t.id.slice(0, 8)}  ${title}  ${t.url}`)
  }
}
