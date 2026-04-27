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
import { runDrag } from './commands/drag.js'
import { runFill } from './commands/fill.js'
import { runScreenshot } from './commands/screenshot.js'
import { runScene } from './commands/scene.js'
import { runSnap } from './commands/snap.js'
import { runStop } from './commands/stop.js'
import { runWait } from './commands/wait.js'
import { runTargets } from './commands/targets.js'
import { runEval } from './commands/eval.js'
import { runConsole } from './commands/console.js'
import { runWatch } from './commands/watch.js'
import type { AgentViewConfig } from '../config/types.js'

const program = new Command()
  .name('agent-view')
  .description('Visual verification CLI for desktop apps')
  .version('0.3.0')

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
  .option('--compact', 'Merge single-child chains onto one line to reduce token count')
  .option('--count', 'Return only the count of matching nodes (no tree output, no ref mutations)')
  .option('--max-lines <n>', 'Hard line budget — truncates output with a "… N more nodes" tail; refs for hidden nodes are still stored', parseMaxLines)
  .option('--diff', 'Show only changes since last dom call (first call returns full tree)')
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
  .command('drag')
  .description('Drag from one point to another via CDP mouse events (HTML5/pointer DnD)')
  .option('--from <ref>', 'Source element by ref from `dom`')
  .option('--to <ref>', 'Target element by ref from `dom`')
  .option('--from-pos <x,y>', 'Source coordinates (canvas, custom DnD)')
  .option('--to-pos <x,y>', 'Target coordinates')
  .option('--steps <n>', 'Intermediate mouseMoved events (default 10)')
  .option('--button <name>', 'Mouse button: left|right|middle (default left)')
  .option('--hold-ms <n>', 'Pause between press and first move, ms (default 0)')
  .option('-w, --window <id>', 'Target window ID or name')
  .action(async (options) => {
    const config = requireConfig()
    await runDrag(config, options)
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
  .option('--crop <filter>', 'Crop to bounding box of matched element (massive vision-token win)')
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
  .option('--compact', 'Merge single-child chains onto one line')
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
  .option('--scale <factor>', 'Capture a screenshot at this scale (0,1] and append to output', parseFloat)
  .action(async (options) => {
    const config = requireConfig()
    await runSnap(config, options)
  })

program
  .command('targets')
  .description('List all CDP targets (pages, workers, service workers)')
  .option('-t, --type <types>', 'Comma-separated type filter (page,shared_worker,service_worker,worker,iframe)')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    const config = requireConfig()
    await runTargets(config, options)
  })

program
  .command('eval <expression>')
  .description('Evaluate JS in a target (requires "allowEval": true in config)')
  .option('-t, --target <id>', 'Target by CDP id, title, or URL substring')
  .option('-w, --window <id>', 'Page-target by id or title (alias of --target restricted to pages)')
  .option('--await', 'Set awaitPromise on Runtime.evaluate')
  .option('--json', 'Output JSON.stringify(result) instead of human-readable')
  .action(async (expression, options) => {
    const config = requireConfig()
    await runEval(config, expression, options)
  })

program
  .command('console')
  .description('Show console messages from attached targets')
  .option('-t, --target <id>', 'Restrict to one target')
  .option('-f, --follow', 'Stream new messages until --timeout elapses')
  .option('--timeout <seconds>', 'Follow window in seconds (default 10)', parseDepth)
  .option('--until <pattern>', 'Exit as soon as a message matches (substring or /regex/); requires --follow')
  .option('-l, --level <levels>', 'Comma-separated level filter (log,info,warn,error,debug)')
  .option('--since <iso>', 'Only messages newer than ISO timestamp')
  .option('--clear', 'Drop the in-memory ring buffer')
  .action(async (options) => {
    const config = requireConfig()
    await runConsole(config, options)
  })

program
  .command('watch <expression>')
  .description('Watch a JS expression and stream JSON-patch diffs (requires "allowEval": true)')
  .option('--interval <ms>', 'Polling interval (default 250, min 50)')
  .option('--duration <s>', 'Stop after N seconds (default 30)')
  .option('--max-changes <n>', 'Stop after N diffs (default 10)')
  .option('--until <expression>', 'Stop when this JS expression becomes truthy')
  .option('--json', 'NDJSON output, one frame per line')
  .option('-t, --target <id>', 'Target by CDP id, title, or URL substring')
  .option('-w, --window <id>', 'Page-target by id or title')
  .action(async (expression, options) => {
    const config = requireConfig()
    await runWatch(config, expression, options)
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

function parseMaxLines(value: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n <= 0) {
    console.error(`Invalid --max-lines value: "${value}" (must be a positive integer)`)
    process.exit(1)
  }
  return n
}

program.parse()
