// `npm start [-- --page=plain]`: vite on 5199, then Electron with CDP on 19223 once vite answers.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'

const VITE_URL = 'http://localhost:5199/'
const electron = createRequire(import.meta.url)('../app/node_modules/electron')

await import('./copy-cesium.mjs')
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' })

while (!(await fetch(VITE_URL).then(() => true, () => false))) {
  await sleep(200)
}

const args = ['main.cjs', '--remote-debugging-port=19223', ...process.argv.slice(2)]
const win = spawn(electron, args, { stdio: 'inherit' })
win.on('exit', () => vite.kill())
