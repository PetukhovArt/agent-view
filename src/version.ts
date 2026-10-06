import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Read at runtime from package.json: one level up from both `src/` (dev) and `dist/` (build). */
export const VERSION = ((): string => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '../package.json')
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version as string
  } catch {
    return '0.0.0'
  }
})()
