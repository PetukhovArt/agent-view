import {
  buildCaptureWrapper,
  checkSizeCap,
  diff,
  readCapture,
  StopReason,
  WATCH_MAX_CONSECUTIVE_ERRORS,
  WatchSizeCapError,
  type WatchFrame,
  type WatchOptions,
} from '../inspectors/watch/index.js'
import type { RuntimeSession } from '../cdp/types.js'

type Emit = (frame: WatchFrame) => boolean

type RunOpts = WatchOptions & {
  /** When `socket.write` returns false, server-side caller can pass false to skip the next emit. */
  emit: Emit
}

export class WatchSession {
  private timer: NodeJS.Timeout | null = null
  private prevValue: unknown = undefined
  private hasPrev = false
  private consecutiveErrors = 0
  private changeCount = 0
  private startedAt = 0
  private stopped = false
  private wrappedExpr: string
  private wrappedUntil?: string
  private onStopped?: () => void

  constructor(
    private readonly session: RuntimeSession,
    private readonly opts: RunOpts,
  ) {
    this.wrappedExpr = buildCaptureWrapper(opts.expression)
    this.wrappedUntil = opts.until ? `Boolean((${opts.until}))` : undefined
  }

  onStop(cb: () => void): void {
    this.onStopped = cb
  }

  async start(): Promise<void> {
    this.startedAt = Date.now()
    await this.tick(true)
    if (!this.stopped) this.scheduleNext()
  }

  /** External stop (sigint, server shutdown). Idempotent. */
  stop(reason: StopReason, ok: boolean): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.opts.emit({ type: 'stop', ts: nowIso(), reason, ok, count: this.changeCount })
    this.onStopped?.()
  }

  private scheduleNext(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      void this.tick(false)
    }, this.opts.intervalMs)
  }

  private async tick(isInit: boolean): Promise<void> {
    if (this.stopped) return

    if (!isInit && Date.now() - this.startedAt >= this.opts.durationS * 1000) {
      this.stop(StopReason.Duration, true)
      return
    }

    let raw: unknown
    try {
      raw = await this.session.evaluate(this.wrappedExpr, { awaitPromise: true, returnByValue: true })
    } catch (err) {
      this.handleError(isInit, err instanceof Error ? err.message : String(err))
      return
    }

    if (this.stopped) return

    const captured = readCapture(raw)

    if (captured.kind === 'error') {
      if (isInit) {
        this.opts.emit({ type: 'init', ts: nowIso(), value: { __watchError: captured.message } })
        this.prevValue = { __watchError: captured.message }
        this.hasPrev = true
        this.consecutiveErrors = 1
        this.scheduleNext()
      } else {
        this.handleError(false, captured.message)
      }
      return
    }

    try {
      checkSizeCap(captured.value)
    } catch (e) {
      const msg = e instanceof WatchSizeCapError ? e.message : (e instanceof Error ? e.message : String(e))
      this.handleError(isInit, msg)
      if (isInit && !this.stopped) {
        // Init still needs to happen — emit with placeholder so subsequent diffs make sense
        this.opts.emit({ type: 'init', ts: nowIso(), value: { __watchError: msg } })
        this.prevValue = { __watchError: msg }
        this.hasPrev = true
        this.scheduleNext()
      }
      return
    }

    this.consecutiveErrors = 0

    if (isInit) {
      this.opts.emit({ type: 'init', ts: nowIso(), value: captured.value })
      this.prevValue = captured.value
      this.hasPrev = true
      // Init does not count toward max-changes; check until on initial value too
      if (await this.checkUntilOrFalse()) {
        this.stop(StopReason.Until, true)
        return
      }
      return
    }

    if (!this.hasPrev) {
      this.prevValue = captured.value
      this.hasPrev = true
    } else {
      const ops = diff(this.prevValue, captured.value)
      if (ops.length > 0) {
        this.opts.emit({ type: 'diff', ts: nowIso(), ops })
        this.prevValue = captured.value
        this.changeCount++
        if (this.changeCount >= this.opts.maxChanges) {
          this.stop(StopReason.MaxChanges, true)
          return
        }
      }
    }

    if (await this.checkUntilOrFalse()) {
      this.stop(StopReason.Until, true)
      return
    }

    if (!this.stopped) this.scheduleNext()
  }

  private async checkUntilOrFalse(): Promise<boolean> {
    if (!this.wrappedUntil) return false
    try {
      const result = await this.session.evaluate(this.wrappedUntil, { awaitPromise: true, returnByValue: true })
      return Boolean(result)
    } catch (err) {
      // Until errors do not affect main error counter (per spec)
      this.opts.emit({
        type: 'error',
        ts: nowIso(),
        message: `--until evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
      })
      return false
    }
  }

  private handleError(isInit: boolean, message: string): void {
    if (this.stopped) return
    if (!isInit) {
      this.opts.emit({ type: 'error', ts: nowIso(), message })
    }
    this.consecutiveErrors++
    if (this.consecutiveErrors >= WATCH_MAX_CONSECUTIVE_ERRORS) {
      this.stop(StopReason.EvalFailed, false)
      return
    }
    if (!isInit && !this.stopped) this.scheduleNext()
  }
}

function nowIso(): string {
  return new Date().toISOString()
}
