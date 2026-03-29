#!/usr/bin/env node

import { Command } from 'commander'
import { readConfig } from '../config/manager.js'
import { runInit } from './commands/init.js'
import { runDiscover } from './commands/discover.js'
import { runDom } from './commands/dom.js'
import { runStop } from './commands/stop.js'
import type { AgentViewConfig } from '../config/types.js'

const program = new Command()
  .name('agent-view')
  .description('Visual verification CLI for desktop apps')
  .version('0.1.0')

program
  .command('init')
  .description('Auto-generate agent-view.config.json')
  .action(() => {
    runInit(process.cwd())
  })

program
  .command('discover')
  .description('Discover running application and its windows')
  .action(async () => {
    const config = requireConfig()
    await runDiscover(config)
  })

program
  .command('dom')
  .description('Get DOM accessibility tree')
  .option('-w, --window <id>', 'Target window ID or name')
  .option('-f, --filter <text>', 'Filter by text/name')
  .option('-d, --depth <n>', 'Max tree depth', parseDepth)
  .action(async (options) => {
    const config = requireConfig()
    await runDom(config, options)
  })

program
  .command('stop')
  .description('Stop the lazy server')
  .action(async () => {
    await runStop()
  })

function requireConfig(): AgentViewConfig {
  const config = readConfig(process.cwd())
  if (!config) {
    console.error('No agent-view.config.json found. Run `agent-view init` first.')
    process.exit(1)
  }
  return config
}

function parseDepth(value: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n)) {
    console.error(`Invalid depth value: "${value}"`)
    process.exit(1)
  }
  return n
}

program.parse()
