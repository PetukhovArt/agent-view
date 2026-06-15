import type { StampedNetworkEntry } from '../../cdp/network-stream.js'
import { NetworkEntryState, NetworkResourceType, WebSocketOpcode, WebSocketDirection } from '../../cdp/types.js'

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
  'x-csrf-token',
  'x-xsrf-token',
])

const OPCODE_NAMES: Record<number, string> = {
  [WebSocketOpcode.Text]: 'text',
  [WebSocketOpcode.Binary]: 'binary',
  [WebSocketOpcode.Close]: 'close',
  [WebSocketOpcode.Ping]: 'ping',
  [WebSocketOpcode.Pong]: 'pong',
  [WebSocketOpcode.Continuation]: 'continuation',
}

export type NetworkRef = {
  ref: number
  targetId: string
  requestId: string
}

export type NetworkListResult = {
  text: string
  refs: NetworkRef[]
  nextRef: number
}

function entryMethod(entry: StampedNetworkEntry): string {
  if (entry.isWebSocket || entry.resourceType === NetworkResourceType.WebSocket) return 'WS'
  if (entry.isEventSource || entry.resourceType === NetworkResourceType.EventSource) return 'SSE'
  return entry.method ?? 'GET'
}

function entryStatus(entry: StampedNetworkEntry): string {
  if (entry.state === NetworkEntryState.Complete) return String(entry.status ?? '')
  if (entry.state === NetworkEntryState.Pending) return 'pending'
  return 'FAILED'
}

function entryTiming(entry: StampedNetworkEntry): string {
  const isWs = entry.isWebSocket || entry.resourceType === NetworkResourceType.WebSocket
  const isSse = entry.isEventSource || entry.resourceType === NetworkResourceType.EventSource

  if (isWs || isSse) {
    const count = entry.frames?.length ?? 0
    return `(${count} frames)`
  }

  if (entry.state === NetworkEntryState.Complete && entry.totalMs !== undefined) {
    return `${entry.totalMs}ms`
  }

  return ''
}

export function formatNetworkList(
  entries: StampedNetworkEntry[],
  opts: { startRef: number; maxLines?: number },
): NetworkListResult {
  if (entries.length === 0) return { text: '(no network activity)', refs: [], nextRef: opts.startRef }

  const refs: NetworkRef[] = entries.map((entry, i) => ({
    ref: opts.startRef + i,
    targetId: entry.targetId,
    requestId: entry.requestId,
  }))
  const nextRef = opts.startRef + entries.length

  const allLines = entries.map((entry, i) => {
    const ref = opts.startRef + i
    const method = entryMethod(entry)
    const status = entryStatus(entry)
    const type = entry.resourceType
    const timing = entryTiming(entry)
    const parts = [`[req=${ref}]`, method, status, type, entry.url]
    if (timing) parts.push(timing)
    return parts.join(' ')
  })

  let text: string
  if (opts.maxLines !== undefined && allLines.length > opts.maxLines) {
    const visible = allLines.slice(0, opts.maxLines - 1)
    const hidden = allLines.length - visible.length
    text = [...visible, `… ${hidden} more requests`].join('\n')
  } else {
    text = allLines.join('\n')
  }

  return { text, refs, nextRef }
}

function redactHeaders(headers: Record<string, string>, rawHeaders: boolean): string {
  return Object.entries(headers)
    .map(([k, v]) => {
      const val = !rawHeaders && SENSITIVE_HEADERS.has(k.toLowerCase()) ? '[redacted]' : v
      return `  ${k}: ${val}`
    })
    .join('\n')
}

export function formatNetworkDetail(
  entry: StampedNetworkEntry,
  opts: { rawHeaders?: boolean } = {},
): string {
  const rawHeaders = opts.rawHeaders ?? false
  const isWs = entry.isWebSocket || entry.resourceType === NetworkResourceType.WebSocket
  const isSse = entry.isEventSource || entry.resourceType === NetworkResourceType.EventSource

  const lines: string[] = []

  if (isWs || isSse) {
    const proto = isWs ? 'WS' : 'SSE'
    lines.push(`${proto} ${entry.url}`)

    if (entry.state === NetworkEntryState.Failed) {
      lines.push(`FAILED${entry.errorText ? ': ' + entry.errorText : ''}`)
    } else {
      lines.push(entry.state)
    }

    if (entry.frames && entry.frames.length > 0) {
      for (const frame of entry.frames) {
        const arrow = frame.direction === WebSocketDirection.Sent ? '↑' : '↓'
        const opName = OPCODE_NAMES[frame.opcode] ?? String(frame.opcode)
        const time = new Date(frame.ts).toISOString().slice(11, 19)

        let payload: string
        if (frame.terminal === 'closed') {
          payload = 'closed'
        } else if (frame.terminal === 'error') {
          payload = `error: ${frame.errorMessage ?? ''}`
        } else if (frame.binary) {
          payload = `[binary ${frame.size}B]`
        } else {
          payload = frame.payload ?? ''
        }

        lines.push(`${arrow} ${opName} ${frame.size}B ${time} ${payload}`)
      }
    }

    return lines.join('\n')
  }

  lines.push(`${entry.method ?? 'GET'} ${entry.url}`)

  if (entry.state === NetworkEntryState.Pending) {
    lines.push('pending')
  } else if (entry.state === NetworkEntryState.Failed) {
    lines.push(`FAILED${entry.errorText ? ': ' + entry.errorText : ''}`)
  } else {
    lines.push(`→ ${entry.status ?? ''} ${entry.statusText ?? ''}`.trimEnd())
  }

  const timingParts: string[] = []
  if (entry.ttfbMs !== undefined) timingParts.push(`ttfb ${entry.ttfbMs}ms`)
  if (entry.totalMs !== undefined) timingParts.push(`total ${entry.totalMs}ms`)
  if (timingParts.length > 0) lines.push(`timing: ${timingParts.join(' ')}`)

  if (entry.requestHeaders && Object.keys(entry.requestHeaders).length > 0) {
    lines.push('request headers:')
    lines.push(redactHeaders(entry.requestHeaders, rawHeaders))
  }

  if (entry.responseHeaders && Object.keys(entry.responseHeaders).length > 0) {
    lines.push('response headers:')
    lines.push(redactHeaders(entry.responseHeaders, rawHeaders))
  }

  if (entry.requestBody !== undefined) {
    lines.push('request body:')
    const body = entry.requestBody
    if (body.length > 4096) {
      lines.push(body.slice(0, 4096))
      lines.push(`… ${body.length - 4096} more bytes`)
    } else {
      lines.push(body)
    }
  }

  if (entry.responseBody !== undefined) {
    lines.push('response body:')
    if (entry.responseBody.binary) {
      lines.push(`[binary ${entry.responseBody.size} bytes]`)
    } else {
      lines.push(entry.responseBody.text)
    }
  }

  return lines.join('\n')
}
