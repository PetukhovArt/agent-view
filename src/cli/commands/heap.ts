import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

export type HeapAction = 'take' | 'summary' | 'diff' | 'retainers' | 'list' | 'clear'

export type HeapOptions = {
  name?: string
  names?: string[]
  class?: string
  filter?: string
  detached?: boolean
  maxLines?: number
  window?: string
  target?: string
}

export async function runHeap(config: AgentViewConfig, action: HeapAction, options: HeapOptions): Promise<void> {
  const response = await sendCommand({
    command: 'heap',
    port: config.port,
    runtime: config.runtime,
    args: {
      action,
      name: options.name,
      names: options.names,
      class: options.class,
      filter: options.filter,
      detached: options.detached,
      maxLines: options.maxLines,
      window: options.window,
      target: options.target,
    },
  })

  if (!response.ok) {
    console.error(response.error)
    process.exit(1)
  }
  console.log(response.data)
}
