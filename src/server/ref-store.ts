type RefEntry = {
  ref: number
  backendDOMNodeId: number
  port: number
  windowId: string
}

export class RefStore {
  private entries = new Map<number, RefEntry>()
  private nextRef = 1

  getNextRef(): number {
    return this.nextRef
  }

  /** Clear old refs for this window, store new ones, update counter */
  store(refs: Array<{ ref: number; backendDOMNodeId: number }>, port: number, windowId: string, nextRef: number): void {
    // Clear previous refs for this window
    for (const [key, entry] of this.entries) {
      if (entry.port === port && entry.windowId === windowId) {
        this.entries.delete(key)
      }
    }
    // Store new refs
    for (const { ref, backendDOMNodeId } of refs) {
      this.entries.set(ref, { ref, backendDOMNodeId, port, windowId })
    }
    this.nextRef = nextRef
  }

  get(ref: number): RefEntry | undefined {
    return this.entries.get(ref)
  }

  clear(): void {
    this.entries.clear()
    this.nextRef = 1
  }
}
