import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_SERVER_PORT = 47922

/** `AGENT_VIEW_SERVER_PORT` runs a dev build next to the installed server. The spawned server inherits it. */
export const SERVER_PORT = Number(process.env.AGENT_VIEW_SERVER_PORT) || DEFAULT_SERVER_PORT

export const TOKEN_DIR = join(homedir(), '.agent-view')

/** Per-port token, so a dev server never overwrites the live server's token. */
export const TOKEN_PATH = join(TOKEN_DIR, SERVER_PORT === DEFAULT_SERVER_PORT ? 'token' : `token-${SERVER_PORT}`)
