import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type UploadOptions = {
  file?: string[]
  selector?: string
  ref?: string
  window?: string
}

export async function runUpload(config: AgentViewConfig, options: UploadOptions): Promise<void> {
  const files = options.file ?? []
  if (files.length === 0) {
    console.error('Usage: agent-view upload --file <path> [--file <path>] --selector <css> | --ref <n>')
    process.exit(1)
  }

  const args: Record<string, unknown> = { files, cwd: process.cwd() }
  if (options.selector) args.selector = options.selector
  if (options.ref !== undefined) {
    const ref = parseInt(options.ref, 10)
    if (isNaN(ref)) {
      console.error(`Invalid ref: "${options.ref}". Expected a number.`)
      process.exit(1)
    }
    args.ref = ref
  }
  if (options.window) args.window = options.window

  const response = await sendCommand({
    command: 'upload',
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
