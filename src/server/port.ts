import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_SERVER_PORT = 47922

/** `AGENT_VIEW_SERVER_PORT` runs a dev build next to the installed server. The spawned server inherits it. */
export const SERVER_PORT = serverPort(process.env.AGENT_VIEW_SERVER_PORT)

/** Home of the token files and saved act scripts. */
export const AGENT_VIEW_DIR = join(homedir(), '.agent-view')

/** Per-port token, so a dev server never overwrites the live server's token. */
export const TOKEN_PATH = join(AGENT_VIEW_DIR, SERVER_PORT === DEFAULT_SERVER_PORT ? 'token' : `token-${SERVER_PORT}`)

function serverPort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_SERVER_PORT
  const port = Number(raw)
  // A typo must not fall back to the default: that is the live server the variable exists to avoid.
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`AGENT_VIEW_SERVER_PORT=${raw} is not a port`)
  return port
}
