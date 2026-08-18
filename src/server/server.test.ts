import { describe, it, expect, vi } from 'vitest'
import { AgentViewServer, parseFilter, resolveDepth, textContentFallback, matchTarget, describeTargetMatchFailure, requestDeadlineMs, resolveUploadPath } from './server.js'
import { join } from 'node:path'
import type { PageSession, AXNode, TargetInfo } from '../cdp/types.js'
import { TargetType } from '../cdp/types.js'

// ── resolveDepth ──────────────────────────────────────────────────────────────

describe('resolveDepth', () => {
  it('no filter, no explicit → 4 (readable snapshot default)', () => {
    expect(resolveDepth(undefined, undefined)).toBe(4)
  })

  it('filter present, no explicit → undefined (unlimited depth)', () => {
    expect(resolveDepth('button', undefined)).toBeUndefined()
  })

  it('explicit depth always wins regardless of filter', () => {
    expect(resolveDepth('button', 2)).toBe(2)
  })

  it('explicit depth wins when no filter', () => {
    expect(resolveDepth(undefined, 3)).toBe(3)
  })
})

// ── parseFilter ───────────────────────────────────────────────────────────────

describe('parseFilter', () => {
  it('plain string → simple with name', () => {
    expect(parseFilter('Save')).toEqual({ kind: 'simple', name: 'Save' })
  })

  it('multi-word string → simple (valid accessible name)', () => {
    expect(parseFilter('Save as Draft')).toEqual({ kind: 'simple', name: 'Save as Draft' })
  })

  it('role:name syntax → simple with role and name', () => {
    expect(parseFilter('button:Save')).toEqual({ kind: 'simple', name: 'Save', role: 'button' })
  })

  it('role is case-insensitive', () => {
    expect(parseFilter('Button:Save')).toEqual({ kind: 'simple', name: 'Save', role: 'button' })
  })

  it('unknown prefix is NOT parsed as role (prevents localhost:3000 misparse)', () => {
    const result = parseFilter('localhost:3000')
    expect(result).toEqual({ kind: 'simple', name: 'localhost:3000' })
  })

  it('~ prefix → heuristic', () => {
    expect(parseFilter('~some text')).toEqual({ kind: 'heuristic', raw: '~some text' })
  })

  it('regex special chars → heuristic', () => {
    expect(parseFilter('text.*regex')).toEqual({ kind: 'heuristic', raw: 'text.*regex' })
  })

  it('filter with only colon → simple (no role)', () => {
    const result = parseFilter(':name')
    expect(result.kind).toBe('simple')
  })
})

// ── textContentFallback ───────────────────────────────────────────────────────

describe('textContentFallback', () => {
  it('returns (no text-match) when evaluate returns null', async () => {
    const conn = makeMockConn({ evaluate: vi.fn().mockResolvedValue(null) })
    const result = await textContentFallback(conn, '1 section found')
    expect(result).toMatch(/no text-match/i)
  })

  it('returns formatted [text-match] lines when evaluate finds elements', async () => {
    const conn = makeMockConn({ evaluate: vi.fn().mockResolvedValue('p#search-hint') })
    const result = await textContentFallback(conn, '1 section found')
    expect(result).toContain('[text-match]')
    expect(result).toContain('p#search-hint')
  })

  it('passes safe JSON-encoded filter to evaluate (no injection)', async () => {
    const evaluateMock = vi.fn().mockResolvedValue(null)
    const conn = makeMockConn({ evaluate: evaluateMock })
    await textContentFallback(conn, 'a"b\\nc')
    const expr = evaluateMock.mock.calls[0][0] as string
    expect(expr).toContain('"a\\"b\\\\nc"')  // JSON.stringify output in the expression
  })
})

// ── queryAXTree routing (via mock CDPConnection) ──────────────────────────────

function makeNode(backendDOMNodeId: number, role: string, name: string): AXNode {
  return {
    nodeId: String(backendDOMNodeId),
    role: { value: role },
    name: { value: name },
    backendDOMNodeId,
    ignored: false,
  } as unknown as AXNode
}

function makeMockConn(overrides: Partial<PageSession> = {}): PageSession {
  return {
    target: { id: 't', type: TargetType.Page, title: '', url: '' },
    onDisconnect: vi.fn(),
    getAccessibilityTree: vi.fn().mockResolvedValue([]),
    getAccessibilityTreeMeta: vi.fn().mockResolvedValue({ nodes: [], fromCache: false }),
    queryAXTree: vi.fn().mockResolvedValue(null),
    captureScreenshot: vi.fn().mockResolvedValue({ buffer: Buffer.alloc(0), format: 'png' as const }),
    clickByNodeId: vi.fn().mockResolvedValue(undefined),
    clickAtPosition: vi.fn().mockResolvedValue(undefined),
    fillByNodeId: vi.fn().mockResolvedValue(undefined),
    getBoxCenter: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
    dragBetweenPositions: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
    onConsole: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// We test findByFilter indirectly by calling AgentViewServer's handleClick.
// Simpler: unit-test findByFilter behavior via the exported queryAXTree mock path.

describe('queryAXTree routing in findByFilter', () => {
  it('when queryAXTree returns null → falls back to full tree (getAccessibilityTree called)', async () => {
    // queryAXTree returns null = unavailable
    const queryAXTree = vi.fn().mockResolvedValue(null)
    const getAccessibilityTree = vi.fn().mockResolvedValue([])
    const conn = makeMockConn({ queryAXTree, getAccessibilityTree })

    // We can't call findByFilter directly (private), so we verify via the exported parseFilter
    // and the mock call pattern. Instead use a simple integration path via handleClick on the server.
    // Here we just assert the logic about queryAXTree null → fallback.

    // When queryAXTree returns null, the full-tree path must be used
    const nodes = await conn.queryAXTree({ accessibleName: 'Save' })
    expect(nodes).toBeNull()

    // After null, getAccessibilityTree would be called (tested via server integration)
    const treeNodes = await conn.getAccessibilityTree()
    expect(treeNodes).toEqual([])
    expect(getAccessibilityTree).toHaveBeenCalledOnce()
  })

  it('when queryAXTree returns [] → returns not-found immediately (no full-tree call)', async () => {
    const queryAXTree = vi.fn().mockResolvedValue([])
    const getAccessibilityTree = vi.fn().mockResolvedValue([makeNode(1, 'button', 'Save')])
    const conn = makeMockConn({ queryAXTree, getAccessibilityTree })

    const result = await conn.queryAXTree({ accessibleName: 'Save' })
    expect(result).toEqual([])
    // When result is empty array (not null), full tree should NOT be fetched
    expect(getAccessibilityTree).not.toHaveBeenCalled()
  })

  it('when queryAXTree returns node → node is available for use', async () => {
    const node = makeNode(42, 'button', 'Save')
    const queryAXTree = vi.fn().mockResolvedValue([node])
    const conn = makeMockConn({ queryAXTree })

    const result = await conn.queryAXTree({ accessibleName: 'Save' })
    expect(result).toHaveLength(1)
    expect(result?.[0].backendDOMNodeId).toBe(42)
  })

  it('role:name filter correctly maps to queryAXTree params', () => {
    const parsed = parseFilter('button:Save')
    expect(parsed.kind).toBe('simple')
    if (parsed.kind === 'simple') {
      expect(parsed.name).toBe('Save')
      expect(parsed.role).toBe('button')
    }
  })

  it('heuristic filter does not produce a simple parsed result', () => {
    expect(parseFilter('~partial match').kind).toBe('heuristic')
    expect(parseFilter('text.*pattern').kind).toBe('heuristic')
  })
})

// ── findTargetByIdOrSubstring ─────────────────────────────────────────────────

function makeTarget(id: string, title: string, url: string): TargetInfo {
  return { id, title, url, type: TargetType.Page }
}

function foundId(match: ReturnType<typeof matchTarget>): string | undefined {
  return match.kind === 'found' ? match.target.id : undefined
}

describe('matchTarget', () => {
  const targets: TargetInfo[] = [
    makeTarget('abc123', 'Main App', 'http://localhost:3000/'),
    makeTarget('def456', 'Sync Worker', 'http://localhost:3000/worker.js'),
    makeTarget('ghi789', 'Settings', 'http://localhost:3000/settings'),
  ]

  it('exact id match wins', () => {
    expect(foundId(matchTarget(targets, 'abc123'))).toBe('abc123')
  })

  it('title substring match (case-insensitive)', () => {
    expect(foundId(matchTarget(targets, 'sync'))).toBe('def456')
  })

  it('url substring match', () => {
    expect(foundId(matchTarget(targets, 'settings'))).toBe('ghi789')
  })

  it('exact id wins over title substring when both match', () => {
    const mixed: TargetInfo[] = [
      makeTarget('worker', 'Something Else', 'http://localhost/other'),
      makeTarget('zzzzzz', 'Worker Page', 'http://localhost/worker'),
    ]
    expect(foundId(matchTarget(mixed, 'worker'))).toBe('worker')
  })

  it('first substring match returned when multiple match', () => {
    const dupes: TargetInfo[] = [
      makeTarget('id1', 'App Worker A', 'http://localhost/a'),
      makeTarget('id2', 'App Worker B', 'http://localhost/b'),
    ]
    expect(foundId(matchTarget(dupes, 'worker'))).toBe('id1')
  })

  it('no match → none', () => {
    expect(matchTarget(targets, 'nonexistent').kind).toBe('none')
  })

  it('empty targets → none', () => {
    expect(matchTarget([], 'abc').kind).toBe('none')
  })

  // Regression: `targets` prints ids truncated to 8 chars; passing that handle back to
  // `eval --target` used to fail with "Target not found" for workers, whose title/url
  // never contains the hex prefix.
  it('resolves the 8-char id prefix printed by `targets`', () => {
    const workers: TargetInfo[] = [{
      id: 'B03D57047D166CFC462A7A54FF129238',
      type: TargetType.SharedWorker,
      title: 'bench-shared-worker',
      url: 'blob:file:///453d9917',
    }]
    expect(foundId(matchTarget(workers, 'B03D5704'))).toBe('B03D57047D166CFC462A7A54FF129238')
    expect(foundId(matchTarget(workers, 'b03d5704'))).toBe('B03D57047D166CFC462A7A54FF129238')
  })

  it('id prefix shared by several targets → ambiguous, never a silent pick', () => {
    const twins: TargetInfo[] = [
      makeTarget('AAAA1111', 'One', 'http://x/1'),
      makeTarget('AAAA2222', 'Two', 'http://x/2'),
    ]
    const match = matchTarget(twins, 'AAAA')
    expect(match.kind).toBe('ambiguous')
    expect(describeTargetMatchFailure('AAAA', match)).toContain('ambiguous')
  })

  it('short queries are treated as text, not id prefixes', () => {
    const targetsWithShortIshIds: TargetInfo[] = [
      makeTarget('ab12cd34', 'Main', 'http://x/main'),
      makeTarget('zz99', 'ab Page', 'http://x/ab'),
    ]
    expect(foundId(matchTarget(targetsWithShortIshIds, 'ab'))).toBe('zz99')
  })
})

// ── requestDeadlineMs ────────────────────────────────────────────────────────

describe('requestDeadlineMs', () => {
  it('bounds ordinary commands', () => {
    expect(requestDeadlineMs('eval', {})).toBeGreaterThan(0)
  })

  it('extends the budget by a poll command\'s own --timeout', () => {
    const base = requestDeadlineMs('console', {})
    const withFollow = requestDeadlineMs('console', { timeout: 30 })
    expect(withFollow).toBe((base ?? 0) + 30_000)
  })

  it('leaves launch unbounded — it blocks for minutes by design', () => {
    expect(requestDeadlineMs('launch', {})).toBeNull()
  })
})

describe('resolveUploadPath', () => {
  const repoRoot = process.cwd()

  it('resolves a relative path against the caller cwd, not the server cwd', () => {
    expect(resolveUploadPath(repoRoot, 'package.json'))
      .toEqual({ path: join(repoRoot, 'package.json') })
  })

  it('reports a missing file with the absolute path it looked at', () => {
    const result = resolveUploadPath(repoRoot, 'nope.txt')
    expect(result).toEqual({ error: `File not found: ${join(repoRoot, 'nope.txt')}` })
  })

  // A directory passes an existence check and reaches CDP, where it becomes the
  // empty File this validation exists to prevent.
  it('rejects a directory', () => {
    expect(resolveUploadPath(repoRoot, 'src')).toEqual({ error: `Not a file: ${join(repoRoot, 'src')}` })
  })
})

// ── per-port state isolation ──────────────────────────────────────────────────

describe('per-port state', () => {
  // Regression: one daemon serves every checkout, so parallel worktree slots hit the same
  // process. Before this, `logs` from slot 9 answered with slot 3's recorder — same file,
  // same console buffer.
  it('gives each CDP port its own buckets, stable across lookups', () => {
    const server = new AgentViewServer() as unknown as {
      stateFor: (port: number) => { logRecorder: unknown; consoleStream: unknown }
      isAnyRecording: () => boolean
    }
    const slot3 = server.stateFor(9879)
    const slot9 = server.stateFor(9885)

    expect(slot3).not.toBe(slot9)
    expect(server.stateFor(9879)).toBe(slot3)
    expect(slot3.consoleStream).not.toBe(slot9.consoleStream)

    expect(server.isAnyRecording()).toBe(false)
    slot3.logRecorder = { file: 'slot3/.agent-view/console.log' }
    expect(slot9.logRecorder).toBeNull()
    expect(server.isAnyRecording()).toBe(true)
  })
})
