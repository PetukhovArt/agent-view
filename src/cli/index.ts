#!/usr/bin/env node

const [nodeMajor] = process.versions.node.split('.').map(Number)
if (nodeMajor < 18) {
  process.stderr.write(`agent-view requires Node.js 18 or higher. Current: ${process.versions.node}\n`)
  process.exit(1)
}

import { Command } from 'commander'
import { readConfig } from '../config/manager.js'
import { runInit } from './commands/init.js'
import { runDiscover } from './commands/discover.js'
import { runLaunch } from './commands/launch.js'
import { runDom } from './commands/dom.js'
import { runClick } from './commands/click.js'
import { runFill } from './commands/fill.js'
import { runScreenshot } from './commands/screenshot.js'
import { runScene } from './commands/scene.js'
import { runSnap } from './commands/snap.js'
import { runStop } from './commands/stop.js'
import { runWait } from './commands/wait.js'
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
  .command('launch')
  .description('Launch application from config and wait for CDP readiness')
  .action(async () => {
    const config = requireConfig()
    await runLaunch(config)
  })

program
  .command('dom')
  .description('Get DOM accessibility tree')
  .option('-w, --window <id>', 'Target window ID or name')
  .option('-f, --filter <text>', 'Filter by text/name')
  .option('-d, --depth <n>', 'Max tree depth', parseDepth)
  .option('--text', 'Fall back to DOM textContent search when AX tree returns no match')
  .action(async (options) => {
    const config = requireConfig()
    await runDom(config, options)
  })

program
  .command('click [ref]')
  .description('Click DOM element by ref, filter, or position')
  .option('-f, --filter <text>', 'Find element by text and click')
  .option('-p, --pos <x,y>', 'Click at coordinates (for canvas)')
  .option('-w, --window <id>', 'Target window ID or name')
  .action(async (ref, options) => {
    const config = requireConfig()
    await runClick(config, ref, options)
  })

program
  .command('fill <refOrValue> [value]')
  .description('Type text into input by ref or filter')
  .option('-f, --filter <text>', 'Find input by label/text and fill')
  .option('-w, --window <id>', 'Target window ID or name')
  .action(async (refOrValue, value, options) => {
    const config = requireConfig()
    await runFill(config, refOrValue, value, options)
  })

program
  .command('wait')
  .description('Wait for element to appear in DOM')
  .requiredOption('-f, --filter <text>', 'Text to wait for')
  .option('-t, --timeout <seconds>', 'Max wait time (default: 10)')
  .option('-w, --window <id>', 'Target window ID or name')
  .action(async (options) => {
    const config = requireConfig()
    await runWait(config, options)
  })

program
  .command('screenshot')
  .description('Capture screenshot and save to temp dir')
  .option('-w, --window <id>', 'Target window ID or name')
  .option('-s, --scale <factor>', 'Scale factor 0..1 — reduces image size and Claude vision token cost (e.g. 0.5)', parseFloat)
  .action(async (options) => {
    const config = requireConfig()
    await runScreenshot(config, options)
  })

program
  .command('scene')
  .description('Get PixiJS scene graph')
  .option('-w, --window <id>', 'Target window ID or name')
  .option('-f, --filter <text>', 'Filter by name')
  .option('-d, --depth <n>', 'Max tree depth', parseDepth)
  .option('-v, --verbose', 'Show extended properties')
  .option('--diff', 'Show only changes since last call')
  .action(async (options) => {
    const config = requireConfig()
    await runScene(config, options)
  })

program
  .command('snap')
  .description('Combined DOM + scene graph snapshot')
  .option('-w, --window <id>', 'Target window ID or name')
  .option('-f, --filter <text>', 'Filter by text/name')
  .option('-d, --depth <n>', 'Max tree depth', parseDepth)
  .action(async (options) => {
    const config = requireConfig()
    await runSnap(config, options)
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
