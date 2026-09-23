import { sendCommand } from '../client.js'
import type { AgentViewConfig } from '../../config/types.js'

type ScreenshotOptions = {
  window?: string
  scale?: number
  crop?: string
  testid?: string
  selector?: string
  cropUp?: number
}

export async function runScreenshot(config: AgentViewConfig, options: ScreenshotOptions): Promise<void> {
  const crops = [options.crop, options.testid, options.selector].filter(f => f !== undefined)
  if (crops.length > 1) {
    console.error('Usage: agent-view screenshot [--crop <filter> | --testid <id> | --selector <css>] — at most one')
    process.exit(1)
  }
  const args: Record<string, unknown> = { testIdAttribute: config.testIdAttribute }
  if (options.window) args.window = options.window
  if (options.testid !== undefined) args.testid = options.testid
  if (options.selector !== undefined) args.selector = options.selector
  if (options.scale !== undefined) args.scale = options.scale
  if (options.crop !== undefined) args.crop = options.crop
  if (options.cropUp !== undefined) args.cropUp = options.cropUp

  const response = await sendCommand({
    command: 'screenshot',
    port: config.port,
    runtime: config.runtime,
    args,
  })

  if (response.ok) {
    if (response.warning) process.stderr.write(`Warning: ${response.warning}\n`)
    console.log(response.data)
  } else {
    console.error(response.error)
    process.exit(1)
  }
}
