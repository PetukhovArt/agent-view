import { sendCommand } from '../client.js'
import { formatEmulation } from '../../server/emulation.js'
import type { EmulationState } from '../../cdp/types.js'
import type { AgentViewConfig } from '../../config/types.js'

type EmulateOptions = {
  window?: string
  width?: number
  height?: number
  scale?: number
  colorScheme?: string
  pointer?: string
  reducedMotion?: boolean
  reset?: boolean
  json?: boolean
}

export async function runEmulate(config: AgentViewConfig, options: EmulateOptions): Promise<void> {
  const args: Record<string, unknown> = {}
  for (const key of ['window', 'width', 'height', 'scale', 'colorScheme', 'pointer', 'reducedMotion', 'reset'] as const) {
    if (options[key] !== undefined) args[key] = options[key]
  }

  const response = await sendCommand({ command: 'emulate', port: config.port, runtime: config.runtime, args })

  if (!response.ok) {
    console.error(response.error)
    process.exit(1)
  }
  const state = response.data as EmulationState
  console.log(options.json ? JSON.stringify(state) : formatEmulation(state))
}
