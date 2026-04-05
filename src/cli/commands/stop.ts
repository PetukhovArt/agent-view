import { sendCommand } from '../client.js'
import { RuntimeType } from '../../types.js'

export async function runStop(): Promise<void> {
  try {
    const response = await sendCommand({
      command: 'stop',
      port: 0,
      runtime: RuntimeType.Browser,
      args: {},
    })

    if (response.ok) {
      console.log('Server stopped')
    } else {
      console.error(`Error: ${response.error}`)
    }
  } catch {
    console.log('Server is not running')
  }
}
