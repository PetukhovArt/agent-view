import { cpSync, existsSync } from 'node:fs'

const target = 'public/cesium'
if (!existsSync(`${target}/Cesium.js`)) {
  cpSync('node_modules/cesium/Build/Cesium', target, { recursive: true })
}
