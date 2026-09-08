// npm `version` hook: the plugin manifest ships inside the npm package, so its
// version must follow package.json. Run by `npm version <bump>`, never by hand.
import { readFileSync, writeFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
const path = '.claude-plugin/plugin.json'
const plugin = JSON.parse(readFileSync(path, 'utf8'))

plugin.version = version
writeFileSync(path, JSON.stringify(plugin, null, 2) + '\n')
