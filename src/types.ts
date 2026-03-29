export type RuntimeType = 'electron' | 'tauri' | 'browser'

export type WebGLEngine = 'pixi' | 'cesium' | 'three'

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
  args: Record<string, unknown>
}

export type ServerResponse = {
  ok: boolean
  data?: unknown
  error?: string
}
