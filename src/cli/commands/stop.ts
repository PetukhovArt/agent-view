import { sendCommand } from '../client.js'

export async function runStop(): Promise<void> {
  try {
    const response = await sendCommand({
      command: 'stop',
      port: 0,
      runtime: 'browser',
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
