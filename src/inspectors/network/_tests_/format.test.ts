import { describe, it, expect } from 'vitest'
import { formatNetworkList, formatNetworkDetail } from '../index.js'
import type { StampedNetworkEntry } from '../../../cdp/network-stream.js'
import {
  NetworkEntryState,
  NetworkResourceType,
  TargetType,
  WebSocketOpcode,
  WebSocketDirection,
} from '../../../cdp/types.js'

function makeEntry(overrides: Partial<StampedNetworkEntry>): StampedNetworkEntry {
  return {
    requestId: 'r1',
    url: 'https://example.com/api',
    method: 'GET',
    resourceType: NetworkResourceType.Xhr,
    state: NetworkEntryState.Complete,
    startTs: 1000,
    targetId: 'target-1',
    targetType: TargetType.Page,
    ...overrides,
  }
}

describe('formatNetworkList', () => {
  it('empty → (no network activity)', () => {
    const result = formatNetworkList([], { startRef: 1 })
    expect(result.text).toBe('(no network activity)')
    expect(result.refs).toEqual([])
    expect(result.nextRef).toBe(1)
  })

  it('completed GET 200 xhr with timing', () => {
    const entry = makeEntry({ status: 200, totalMs: 142 })
    const result = formatNetworkList([entry], { startRef: 1 })
    expect(result.text).toBe('[req=1] GET 200 xhr https://example.com/api 142ms')
    expect(result.refs).toEqual([{ ref: 1, targetId: 'target-1', requestId: 'r1' }])
    expect(result.nextRef).toBe(2)
  })

  it('pending entry → pending, no timing', () => {
    const entry = makeEntry({ state: NetworkEntryState.Pending })
    const result = formatNetworkList([entry], { startRef: 5 })
    expect(result.text).toBe('[req=5] GET pending xhr https://example.com/api')
    expect(result.nextRef).toBe(6)
  })

  it('failed entry → FAILED', () => {
    const entry = makeEntry({ state: NetworkEntryState.Failed, errorText: 'net::ERR_CONN' })
    const result = formatNetworkList([entry], { startRef: 1 })
    expect(result.text).toContain('FAILED')
    expect(result.text).not.toContain('ms')
  })

  it('websocket list line → WS + (N frames)', () => {
    const entry = makeEntry({
      resourceType: NetworkResourceType.WebSocket,
      isWebSocket: true,
      method: undefined,
      state: NetworkEntryState.Complete,
      frames: [
        { direction: WebSocketDirection.Sent, opcode: WebSocketOpcode.Text, ts: 1000, size: 10, payload: 'hi' },
        { direction: WebSocketDirection.Received, opcode: WebSocketOpcode.Text, ts: 1001, size: 5, payload: 'ho' },
      ],
    })
    const result = formatNetworkList([entry], { startRef: 1 })
    expect(result.text).toContain('WS')
    expect(result.text).toContain('(2 frames)')
    expect(result.text).not.toContain('ms')
  })

  it('ref numbering starts at startRef and nextRef is correct', () => {
    const e1 = makeEntry({ requestId: 'a' })
    const e2 = makeEntry({ requestId: 'b', status: 404, totalMs: 10 })
    const result = formatNetworkList([e1, e2], { startRef: 10 })
    expect(result.refs[0].ref).toBe(10)
    expect(result.refs[1].ref).toBe(11)
    expect(result.nextRef).toBe(12)
  })

  it('maxLines: text truncated with tail, refs cover ALL entries', () => {
    const entries = [1, 2, 3, 4, 5].map(i =>
      makeEntry({ requestId: `r${i}`, status: 200, totalMs: i * 10 })
    )
    const result = formatNetworkList(entries, { startRef: 1, maxLines: 3 })

    const textLines = result.text.split('\n')
    expect(textLines).toHaveLength(3)
    expect(textLines[2]).toBe('… 3 more requests')

    expect(result.refs).toHaveLength(5)
    expect(result.refs[4].ref).toBe(5)
    expect(result.nextRef).toBe(6)
  })
})

describe('formatNetworkDetail', () => {
  it('sensitive header redacted by default, shown with rawHeaders:true', () => {
    const entry = makeEntry({
      status: 200,
      statusText: 'OK',
      requestHeaders: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    })

    const redacted = formatNetworkDetail(entry)
    expect(redacted).toContain('authorization: [redacted]')
    expect(redacted).toContain('content-type: application/json')
    expect(redacted).not.toContain('Bearer secret')

    const raw = formatNetworkDetail(entry, { rawHeaders: true })
    expect(raw).toContain('authorization: Bearer secret')
  })

  it('binary response body → [binary N bytes]', () => {
    const entry = makeEntry({
      status: 200,
      responseBody: { text: '', base64: true, size: 1234, binary: true },
    })
    const detail = formatNetworkDetail(entry)
    expect(detail).toContain('[binary 1234 bytes]')
  })

  it('text response body shown', () => {
    const entry = makeEntry({
      status: 200,
      responseBody: { text: '{"ok":true}', base64: false, size: 11, binary: false },
    })
    const detail = formatNetworkDetail(entry)
    expect(detail).toContain('response body:')
    expect(detail).toContain('{"ok":true}')
  })

  it('WS frame log: arrows, opcode names, terminal closed frame', () => {
    const entry = makeEntry({
      resourceType: NetworkResourceType.WebSocket,
      isWebSocket: true,
      method: undefined,
      state: NetworkEntryState.Complete,
      frames: [
        { direction: WebSocketDirection.Sent, opcode: WebSocketOpcode.Text, ts: 0, size: 3, payload: 'hey' },
        { direction: WebSocketDirection.Received, opcode: WebSocketOpcode.Text, ts: 1, size: 2, payload: 'ok' },
        { direction: WebSocketDirection.Received, opcode: WebSocketOpcode.Close, ts: 2, size: 0, terminal: 'closed' },
      ],
    })
    const detail = formatNetworkDetail(entry)
    expect(detail).toContain('↑ text 3B')
    expect(detail).toContain('hey')
    expect(detail).toContain('↓ text 2B')
    expect(detail).toContain('ok')
    expect(detail).toContain('↓ close 0B')
    expect(detail).toContain('closed')
  })

  it('pending entry shows pending state', () => {
    const entry = makeEntry({ state: NetworkEntryState.Pending, status: undefined })
    const detail = formatNetworkDetail(entry)
    expect(detail).toContain('pending')
  })

  it('failed entry shows FAILED with errorText', () => {
    const entry = makeEntry({ state: NetworkEntryState.Failed, errorText: 'net::ERR_ABORT' })
    const detail = formatNetworkDetail(entry)
    expect(detail).toContain('FAILED: net::ERR_ABORT')
  })
})
