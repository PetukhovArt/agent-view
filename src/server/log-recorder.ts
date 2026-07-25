import { closeSync, mkdirSync, openSync, readSync, renameSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { ConsoleLevel, type RuntimeSession } from '../cdp/types.js'
import type { StampedConsoleMessage } from '../cdp/_tests/console-stream.js'
import { buildMatcher } from './pattern.js'

export const DEFAULT_LOG_FILE = '.agent-view/console.log'
export const DEFAULT_RESCAN_MS = 3_000
export const MIN_RESCAN_MS = 500
export const DEFAULT_LOG_MAX_BYTES = 8 * 1024 * 1024
export const DEFAULT_TAIL_LINES = 200
/** Tail/grep never scans more than this from the end of the feed. */
export const DEFAULT_SCAN_BYTES = 8 * 1024 * 1024
const RECORD_CAP = 4_000
const RECORDER_ORIGIN = 'recorder'
/** After this many failed injections into one target the probe is dropped for it. */
const PROBE_MAX_FAILURES = 3
const PROBE_REGISTRY = 'globalThis.__avProbes'

/** A probe is arbitrary JS re-evaluated in every newly discovered target — `allowEval` territory. */
export type ProbeSpec = {
  name: string
  source: string
  /** Restricts the probe to targets whose type/title/url/id contains this (case-insensitive). */
  targetQuery?: string
}

export type LogRecorderOptions = {
  /** Absolute path of the feed file. */
  file: string
  levels?: ReadonlySet<ConsoleLevel>
  targetId?: string
  rescanMs?: number
  /** Per-rescan budget. Default `max(2 × rescanMs, 10s)`. */
  tickTimeoutMs?: number
  maxBytes?: number
  truncate?: boolean
  probes?: ProbeSpec[]
  /** Attach every matching target and return the sessions the console feed now reads. */
  rescan: () => Promise<RuntimeSession[]>
  subscribe: (handler: (msg: StampedConsoleMessage) => void) => () => void
}

export type RecorderStatus = {
  file: string
  startedAt: number
  lines: number
  bytes: number
  rotations: number
  attached: string[]
  levels: string[] | null
  targetId: string | null
  rescanMs: number
  ticks: number
  lastTickAt: number | null
  probes: { name: string; targetQuery?: string; injections: number }[]
  lastError: string | null
}

export function localStamp(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/**
 * One record is exactly one physical line — newlines in the message (stacks, JSON payloads)
 * become a literal `\n`. Wrapped records break every line-oriented filter, ours and the
 * agent's `grep`/`awk` alike, so the escaping is a contract of the feed format.
 */
export function formatLogRecord(msg: StampedConsoleMessage): string {
  const origin = `${msg.targetType}:${msg.targetId.slice(0, 8)}`
  const body = msg.stack ? `${msg.text}\n${msg.stack}` : msg.text
  return `${localStamp(msg.ts)} [${msg.level}] [${origin}] ${escapeRecord(body)}`
}

export function escapeRecord(text: string): string {
  const flat = text.replace(/\r\n|\r|\n/g, '\\n')
  if (flat.length <= RECORD_CAP) return flat
  return `${flat.slice(0, RECORD_CAP)}…(+${flat.length - RECORD_CAP} chars)`
}

export type TailFilter = {
  grep?: string
  /** `HH:MM:SS.mmm` clock string, as produced by `parseSinceToken`. */
  since?: string
  level?: ReadonlySet<ConsoleLevel>
  limit?: number
}

const RECORD_HEAD = /^(\d{2}:\d{2}:\d{2}\.\d{3}) \[([a-z]+)\] /

/** Keeps the newest `limit` matches, so a tail stays a tail even with filters on. */
export function filterLogLines(lines: string[], filter: TailFilter = {}): string[] {
  const matcher = filter.grep ? buildMatcher(filter.grep) : null
  const out: string[] = []
  for (const line of lines) {
    if (!line) continue
    const head = RECORD_HEAD.exec(line)
    if (filter.since !== undefined && (!head || head[1] < filter.since)) continue
    if (filter.level && (!head || !filter.level.has(head[2] as ConsoleLevel))) continue
    if (matcher && !matcher(line)) continue
    out.push(line)
  }
  const limit = filter.limit ?? DEFAULT_TAIL_LINES
  return out.length > limit ? out.slice(out.length - limit) : out
}

/**
 * `--since` accepts `-5m` / `-30s` / `-2h`, a clock time (`09:31`, `09:31:02.500`), or an
 * ISO timestamp. Returns the `HH:MM:SS.mmm` local-clock string the feed is compared against,
 * or null when the token is unparseable. Comparison is clock-only: a feed spanning midnight
 * needs the file itself, not `--since`.
 */
export function parseSinceToken(token: string, now: Date = new Date()): string | null {
  const raw = token.trim()

  const relative = /^-(\d+)(s|m|h)$/i.exec(raw)
  if (relative) {
    const unit = relative[2].toLowerCase()
    const factor = unit === 's' ? 1_000 : unit === 'm' ? 60_000 : 3_600_000
    return localStamp(now.getTime() - Number(relative[1]) * factor)
  }

  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(raw)
  if (clock) {
    const hours = Number(clock[1])
    if (hours > 23) return null
    return `${pad(hours)}:${clock[2]}:${clock[3] ?? '00'}.${(clock[4] ?? '').padEnd(3, '0')}`
  }

  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : localStamp(parsed)
}

export function resolveLogFile(projectDir: string, configured?: string): string {
  const raw = configured?.trim() ? configured.trim() : DEFAULT_LOG_FILE
  return isAbsolute(raw) ? raw : join(projectDir, raw)
}

export function readFeedLines(file: string, maxScanBytes: number = DEFAULT_SCAN_BYTES): { lines: string[]; scanTruncated: boolean } {
  const size = statSync(file).size
  const start = size > maxScanBytes ? size - maxScanBytes : 0
  const length = size - start
  if (length === 0) return { lines: [], scanTruncated: false }

  const fd = openSync(file, 'r')
  let text: string
  try {
    const buf = Buffer.allocUnsafe(length)
    readSync(fd, buf, 0, length, start)
    text = buf.toString('utf8')
  } finally {
    closeSync(fd)
  }

  if (start > 0) {
    // The scan window starts mid-record (and possibly mid-codepoint) — drop that fragment.
    const firstBreak = text.indexOf('\n')
    text = firstBreak === -1 ? '' : text.slice(firstBreak + 1)
  }

  return { lines: text.split('\n').filter(l => l.length > 0), scanTruncated: start > 0 }
}

/**
 * Appends the console feed of every attached target to one file, and keeps discovering
 * targets while it runs: a page reload keeps its target id, but a worker restart produces
 * a new one, so without the rescan the feed silently loses the worker it was recording.
 * Writes are synchronous fd appends — a single writer, and rotation needs no flush dance.
 */
export class LogRecorder {
  readonly file: string
  readonly startedAt = Date.now()
  private readonly rescanMs: number
  private readonly tickTimeoutMs: number
  private readonly maxBytes: number
  private readonly probes: ProbeSpec[]
  private fd: number | null = null
  private bytes = 0
  private lines = 0
  private rotations = 0
  private unsubscribe: (() => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private attached: string[] = []
  private ticks = 0
  private lastTickAt: number | null = null
  private probeFailures = new Map<string, number>()
  private injections = new Map<string, number>()
  private lastError: string | null = null

  constructor(private readonly opts: LogRecorderOptions) {
    this.file = opts.file
    this.rescanMs = Math.max(MIN_RESCAN_MS, opts.rescanMs ?? DEFAULT_RESCAN_MS)
    this.tickTimeoutMs = opts.tickTimeoutMs ?? Math.max(2 * this.rescanMs, 10_000)
    this.maxBytes = opts.maxBytes ?? DEFAULT_LOG_MAX_BYTES
    this.probes = opts.probes ?? []
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true })
    this.open(this.opts.truncate ?? false)
    this.mark(`recording started (rescan ${this.rescanMs}ms, cap ${Math.round(this.maxBytes / 1024)}KB)`)
    this.unsubscribe = this.opts.subscribe((msg) => this.onMessage(msg))
    await this.tick()
  }

  stop(reason: string): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.unsubscribe?.()
    this.unsubscribe = null
    this.mark(`recording stopped (${reason}) — ${this.lines} lines`)
    if (this.fd !== null) {
      closeSync(this.fd)
      this.fd = null
    }
  }

  /** `logs clear`: truncate the feed in place, keeping the recording alive. */
  clearFeed(): void {
    if (this.fd !== null) {
      closeSync(this.fd)
      this.fd = null
    }
    this.open(true)
    this.lines = 0
    this.mark('feed cleared')
  }

  status(): RecorderStatus {
    return {
      file: this.file,
      startedAt: this.startedAt,
      lines: this.lines,
      bytes: this.bytes,
      rotations: this.rotations,
      attached: [...this.attached],
      levels: this.opts.levels ? [...this.opts.levels] : null,
      targetId: this.opts.targetId ?? null,
      rescanMs: this.rescanMs,
      ticks: this.ticks,
      lastTickAt: this.lastTickAt,
      probes: this.probes.map(p => ({
        name: p.name,
        targetQuery: p.targetQuery,
        injections: this.injections.get(p.name) ?? 0,
      })),
      lastError: this.lastError,
    }
  }

  private onMessage(msg: StampedConsoleMessage): void {
    if (this.opts.targetId && msg.targetId !== this.opts.targetId) return
    if (this.opts.levels && !this.opts.levels.has(msg.level)) return
    this.write(formatLogRecord(msg))
  }

  /**
   * A rescan that never settles is the worst outcome: the feed keeps its current targets and
   * silently stops picking up new ones, which reads exactly like "the app went quiet". Bound
   * the tick and always reschedule.
   */
  private async tick(): Promise<void> {
    if (this.stopped) return
    try {
      const sessions = await withDeadline(this.opts.rescan(), this.tickTimeoutMs, 'rescan')
      await withDeadline(this.injectProbes(sessions), this.tickTimeoutMs, 'probe injection')
      this.attached = sessions.map(s => `${s.target.type}:${s.target.id.slice(0, 8)}`)
    } catch (err) {
      this.fail(`rescan failed: ${errorText(err)}`)
    }
    this.ticks++
    this.lastTickAt = Date.now()
    this.schedule()
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => { void this.tick() }, this.rescanMs)
  }

  /**
   * Re-inject by *presence check*, not by target id: a page reload keeps its target id but
   * wipes every global, so an id-keyed "already injected" set would leave the feed with a
   * probe that no longer exists. The marker lives in the target, which is the only place
   * that knows whether the context survived.
   */
  private async injectProbes(sessions: RuntimeSession[]): Promise<void> {
    for (const session of sessions) {
      for (const probe of this.probes) {
        if (!targetMatchesProbe(session, probe)) continue
        const key = `${session.target.id}:${probe.name}`
        if ((this.probeFailures.get(key) ?? 0) >= PROBE_MAX_FAILURES) continue
        const origin = `${session.target.type}:${session.target.id.slice(0, 8)}`
        try {
          const present = await session.evaluate(probeMarkerCheck(probe.name), { returnByValue: true })
          if (present === true) continue
          await session.evaluate(probeWithMarker(probe), { awaitPromise: true, returnByValue: true })
          this.injections.set(probe.name, (this.injections.get(probe.name) ?? 0) + 1)
          this.mark(`probe ${probe.name} injected into ${origin}`)
        } catch (err) {
          const failures = (this.probeFailures.get(key) ?? 0) + 1
          this.probeFailures.set(key, failures)
          const giveUp = failures >= PROBE_MAX_FAILURES ? ' — giving up on this target' : ''
          this.fail(`probe ${probe.name} failed in ${origin}: ${errorText(err)}${giveUp}`)
        }
      }
    }
  }

  private open(truncate: boolean): void {
    this.fd = openSync(this.file, truncate ? 'w' : 'a')
    this.bytes = truncate ? 0 : fileSize(this.file)
  }

  private write(line: string): void {
    if (this.fd === null) return
    const buf = Buffer.from(`${line}\n`, 'utf8')
    if (this.bytes + buf.length > this.maxBytes) this.rotate()
    this.append(buf)
  }

  private append(buf: Buffer): void {
    if (this.fd === null) return
    try {
      writeSync(this.fd, buf)
      this.bytes += buf.length
      this.lines++
    } catch (err) {
      this.lastError = `write failed: ${errorText(err)}`
    }
  }

  private rotate(): void {
    if (this.fd !== null) {
      closeSync(this.fd)
      this.fd = null
    }
    try {
      renameSync(this.file, `${this.file}.prev`)
    } catch (err) {
      this.lastError = `rotate failed: ${errorText(err)}`
    }
    this.rotations++
    this.open(true)
    this.append(Buffer.from(`${markerLine(`rotated — previous feed is ${basename(this.file)}.prev`)}\n`, 'utf8'))
  }

  private mark(text: string): void {
    this.write(markerLine(text))
  }

  private fail(text: string): void {
    this.lastError = text
    this.mark(text)
  }
}

function markerLine(text: string): string {
  return `${localStamp(Date.now())} [${ConsoleLevel.Info}] [${RECORDER_ORIGIN}] ${escapeRecord(text)}`
}

function probeMarkerCheck(name: string): string {
  return `!!(${PROBE_REGISTRY} && ${PROBE_REGISTRY}[${JSON.stringify(name)}])`
}

/** Marker is set by a plain statement, not `eval` — a strict CSP must not break probes. */
function probeWithMarker(probe: ProbeSpec): string {
  return `${probe.source}\n;${PROBE_REGISTRY} = ${PROBE_REGISTRY} || {};\n${PROBE_REGISTRY}[${JSON.stringify(probe.name)}] = 1;`
}

function targetMatchesProbe(session: RuntimeSession, probe: ProbeSpec): boolean {
  if (!probe.targetQuery) return true
  const q = probe.targetQuery.toLowerCase()
  const { id, type, title, url } = session.target
  return type.toLowerCase().includes(q)
    || id.toLowerCase().startsWith(q)
    || title.toLowerCase().includes(q)
    || url.toLowerCase().includes(q)
}

function fileSize(file: string): number {
  try {
    return statSync(file).size
  } catch {
    return 0
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (err) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error(String(err))) },
    )
  })
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0')
}
