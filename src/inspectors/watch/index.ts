import jsonpatch from 'fast-json-patch'
import { WATCH_SIZE_CAP_BYTES, WatchSizeCapError, type JsonPatchOp } from './types.js'

export { StopReason, WATCH_SIZE_CAP_BYTES, WATCH_MAX_CONSECUTIVE_ERRORS, WATCH_MIN_INTERVAL_MS, WatchSizeCapError } from './types.js'
export type { WatchFrame, WatchInitFrame, WatchDiffFrame, WatchErrorFrame, WatchStopFrame, WatchOptions, JsonPatchOp } from './types.js'

/**
 * Browser-side wrapper. Deep-clones via JSON to surface non-cloneable values as a stable error shape.
 */
export function buildCaptureWrapper(userExpression: string): string {
  return `(function(){try{return JSON.parse(JSON.stringify((${userExpression})))}catch(e){return {__watchError: e && e.message ? String(e.message) : String(e)}}})()`
}

export type CapturedValue = { kind: 'value'; value: unknown } | { kind: 'error'; message: string }

export function readCapture(raw: unknown): CapturedValue {
  if (raw && typeof raw === 'object' && '__watchError' in raw) {
    const msg = (raw as { __watchError: unknown }).__watchError
    return { kind: 'error', message: typeof msg === 'string' ? msg : String(msg) }
  }
  return { kind: 'value', value: raw }
}

export function checkSizeCap(value: unknown): number {
  const json = JSON.stringify(value) ?? 'undefined'
  const bytes = Buffer.byteLength(json, 'utf8')
  if (bytes > WATCH_SIZE_CAP_BYTES) throw new WatchSizeCapError(bytes)
  return bytes
}

function isObjectOrArray(v: unknown): v is object {
  return v !== null && typeof v === 'object'
}

export function diff(prev: unknown, next: unknown): JsonPatchOp[] {
  // fast-json-patch.compare only supports Object|Array roots. Handle primitives + type changes ourselves.
  if (!isObjectOrArray(prev) || !isObjectOrArray(next)) {
    if (prev === next) return []
    return [{ op: 'replace', path: '', value: next }]
  }
  if (Array.isArray(prev) !== Array.isArray(next)) {
    return [{ op: 'replace', path: '', value: next }]
  }
  return jsonpatch.compare(prev, next) as JsonPatchOp[]
}
