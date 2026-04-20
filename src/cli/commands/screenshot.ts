import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type ScreenshotOptions = {
  window?: string
  scale?: number
}

export async function runScreenshot(config: AgentViewConfig, options: ScreenshotOptions): Promise<void> {
  const args: Record<string, unknown> = {}
  if (options.window) args.window = options.window
  if (options.scale !== undefined) args.scale = options.scale

  const response = await sendCommand({
    command: 'screenshot',
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
