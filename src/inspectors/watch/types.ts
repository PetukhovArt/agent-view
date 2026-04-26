export enum StopReason {
  MaxChanges = 'max-changes',
  Duration = 'duration',
  Until = 'until',
  Sigint = 'sigint',
  EvalFailed = 'eval-failed',
  ServerShutdown = 'server-shutdown',
}

export type JsonPatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'test'; path: string; value: unknown }

export type WatchInitFrame = { type: 'init'; ts: string; value: unknown }
export type WatchDiffFrame = { type: 'diff'; ts: string; ops: JsonPatchOp[] }
export type WatchErrorFrame = { type: 'error'; ts: string; message: string }
export type WatchStopFrame = { type: 'stop'; ts: string; reason: StopReason; ok: boolean; count?: number }

export type WatchFrame = WatchInitFrame | WatchDiffFrame | WatchErrorFrame | WatchStopFrame

export type WatchOptions = {
  expression: string
  intervalMs: number
  durationS: number
  maxChanges: number
  until?: string
}

export const WATCH_SIZE_CAP_BYTES = 256 * 1024
export const WATCH_MAX_CONSECUTIVE_ERRORS = 5
export const WATCH_MIN_INTERVAL_MS = 50

export class WatchSizeCapError extends Error {
  constructor(public readonly bytes: number) {
    super(`value exceeds ${WATCH_SIZE_CAP_BYTES} byte cap (got ${bytes}); narrow your expression`)
    this.name = 'WatchSizeCapError'
  }
}
