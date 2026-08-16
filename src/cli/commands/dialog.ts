import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

export type DialogAction = 'status' | 'accept' | 'dismiss' | 'policy' | 'arm' | 'disarm'

type DialogOptions = {
  text?: string
  file?: string[]
  cancel?: boolean
  window?: string
}

export async function runDialog(
  config: AgentViewConfig,
  action: DialogAction,
  mode: string | undefined,
  options: DialogOptions,
): Promise<void> {
  const args: Record<string, unknown> = { action }
  if (mode !== undefined) args.mode = mode
  if (options.text !== undefined) args.text = options.text
  if (options.file && options.file.length > 0) args.files = options.file
  if (options.cancel) args.cancel = true
  if (options.window) args.window = options.window
  if (action === 'arm') args.cwd = process.cwd()

  const response = await sendCommand({
    command: 'dialog',
    port: config.port,
    runtime: config.runtime,
    args,
  })

  if (response.ok) {
    console.log(response.data)
  } else {
    console.error(response.error)
    process.exit(1)
  }
}
