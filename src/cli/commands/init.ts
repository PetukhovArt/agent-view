import { generateConfig, writeConfig, readConfig } from '../../config/manager.js'

export function runInit(cwd: string): void {
  const existing = readConfig(cwd)
  if (existing) {
    console.log('agent-view.config.json already exists:')
    console.log(JSON.stringify(existing, null, 2))
    return
  }

  const config = generateConfig(cwd)
  writeConfig(cwd, config)
  console.log('Generated agent-view.config.json:')
  console.log(JSON.stringify(config, null, 2))
}
