export enum RuntimeType {
  Electron = 'electron',
  Tauri = 'tauri',
  Browser = 'browser',
}

export enum WebGLEngine {
  Pixi = 'pixi',
}

export type WindowInfo = {
  id: string
  title: string
  url: string
  type: string
}

export type RuntimeInfo = {
  runtime: RuntimeType
  port: number
  windows: WindowInfo[]
}

export type ServerRequest = {
  command: string
  port: number
  runtime: RuntimeType
  engine?: WebGLEngine
  args: Record<string, unknown>
  token?: string
}

export type ServerResponse = {
  ok: boolean
  data?: unknown
  error?: string
}
