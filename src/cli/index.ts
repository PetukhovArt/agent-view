#!/usr/bin/env node

const [nodeMajor] = process.versions.node.split('.').map(Number)
if (nodeMajor < 18) {
  process.stderr.write(`agent-view requires Node.js 18 or higher. Current: ${process.versions.node}\n`)
  process.exit(1)
}

import { Command } from 'commander'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { findConfig } from '../config/manager.js'
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
import { runNetwork } from './commands/network.js'
import { runLogs } from './commands/logs.js'
import { runWatch } from './commands/watch.js'
import type { AgentViewConfig } from '../config/types.js'

// Resolve version from package.json at runtime — same path in dev (src/cli) and build (dist/cli).
function resolveVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version as string
  } catch {
    return '0.0.0'
  }
}

const program = new Command()
  .name('agent-view')
  .description('Visual verification CLI for desktop apps')
  .version(resolveVersion())

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
  .option('--double', 'Double-click (fires dblclick handlers)')
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
  .option('--crop-up <n>', 'Climb N element ancestors from the --crop match before cropping (heading → its card)', parseCropUp)
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
  .command('network')
  .description('List captured network requests, or expand one with --req')
  .option('--req <n>', 'Expand one request by its [req=N] handle (headers, timing, body, WS frames)')
  .option('--url <glob>', 'Filter by URL substring, or glob when it contains *')
  .option('--method <list>', 'Filter by HTTP method(s), comma-separated (e.g. POST,PUT)')
  .option('--status <list>', 'Filter by status class, code, or "failed", comma-separated (e.g. 4xx,5xx,404,failed)')
  .option('--type <list>', 'Filter by resource type(s), comma-separated (e.g. xhr,fetch)')
  .option('--raw-headers', 'Reveal real values of sensitive headers (redacted by default)')
  .option('-f, --follow', 'Stream new requests until --timeout elapses')
  .option('--until <pattern>', 'Exit as soon as a request matches (substring or /regex/); requires --follow')
  .option('--timeout <seconds>', 'Follow window in seconds (default 10)')
  .option('--max-lines <n>', 'Hard line budget for the list (default 50)')
  .option('--since <iso>', 'Only requests newer than ISO timestamp')
  .option('--clear', 'Drop the in-memory ring buffer')
  .option('-t, --target <id>', 'Restrict to one target by CDP id, title, or URL substring')
  .option('-w, --window <id>', 'Page-target by id or title')
  .action(async (options) => {
    const config = requireConfig()
    await runNetwork(config, options)
  })

const logs = program
  .command('logs')
  .description('Record the console feed of every target to a file, then tail/filter/clear it')

logs
  .command('start')
  .description('Start recording (survives page reloads and worker restarts; keeps the server alive)')
  .option('--file <path>', 'Feed file (default: config logFile, else .agent-view/console.log)')
  .option('-t, --target <id>', 'Record one target only (CDP id, id prefix, title, or URL substring)')
  .option('-l, --level <levels>', 'Comma-separated level filter (log,info,warn,error,debug)')
  .option('--rescan <ms>', 'Target rediscovery interval, min 500 (default 3000)', parseDepth)
  .option('--truncate', 'Start from an empty feed instead of appending')
  .option('--probe <path[@target]>', 'Inject a JS probe into matching targets, re-injected after restarts (requires allowEval)', collectProbe, [])
  .action(async (options) => {
    const config = requireConfig()
    await runLogs(config, 'start', options)
  })

logs
  .command('stop')
  .description('Stop recording (the feed file stays readable)')
  .option('--file <path>', 'Feed file to report on')
  .action(async (options) => {
    const config = requireConfig()
    await runLogs(config, 'stop', options)
  })

logs
  .command('status')
  .description('Show recording state, attached targets, feed size')
  .option('--file <path>', 'Feed file to report on')
  .action(async (options) => {
    const config = requireConfig()
    await runLogs(config, 'status', options)
  })

logs
  .command('tail', { isDefault: true })
  .description('Print the tail of the feed (default 200 records)')
  .option('-n, --lines <n>', 'Records to print (default 200)', parseMaxLines)
  .option('--grep <pattern>', 'Keep records matching a substring or /regex/')
  .option('--since <when>', 'Records at or after -5m | -30s | 09:31 | 09:31:02.500 | ISO timestamp')
  .option('-l, --level <levels>', 'Comma-separated level filter (log,info,warn,error,debug)')
  .option('--file <path>', 'Feed file to read')
  .action(async (options) => {
    const config = requireConfig()
    await runLogs(config, 'tail', options)
  })

logs
  .command('clear')
  .description('Truncate the feed and drop the in-memory console buffer')
  .option('--file <path>', 'Feed file to truncate')
  .action(async (options) => {
    const config = requireConfig()
    await runLogs(config, 'clear', options)
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

/**
 * Resolves the project by walking up from cwd, then chdirs into the config's directory:
 * every command sends `cwd` to the server for config/policy re-reads, and `launch` spawns
 * the app there. Running from a subdirectory must behave like running from the root.
 */
function requireConfig(): AgentViewConfig {
  const found = findConfig(process.cwd())
  if (!found) {
    console.error('No agent-view.config.json found in this directory or any parent. Run `agent-view init` first.')
    process.exit(1)
  }
  if (found.dir !== process.cwd()) process.chdir(found.dir)
  return found.config
}

function parseDepth(value: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n)) {
    console.error(`Invalid depth value: "${value}"`)
    process.exit(1)
  }
  return n
}

function collectProbe(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function parseCropUp(value: string): number {
  const n = parseInt(value, 10)
  if (isNaN(n) || n < 0) {
    console.error(`Invalid --crop-up value: "${value}" (must be 0 or a positive integer)`)
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
