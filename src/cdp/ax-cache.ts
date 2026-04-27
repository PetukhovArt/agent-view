import type { AXNode } from './types.js'

const AX_CACHE_TTL_MS = 300

type CacheEntry = {
  nodes: AXNode[]
  timestamp: number
}

export type AxTreeResult = {
  nodes: AXNode[]
  fromCache: boolean
}

export class AxTreeCache {
  private entries = new Map<string, CacheEntry>()

  get(key: string): AXNode[] | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (Date.now() - entry.timestamp > AX_CACHE_TTL_MS) {
      this.entries.delete(key)
      return null
    }
    return entry.nodes
  }

  getWithMeta(key: string): AxTreeResult & { found: boolean } {
    const cached = this.get(key)
    if (cached) {
      return { nodes: cached, fromCache: true, found: true }
    }
    return { nodes: [], fromCache: false, found: false }
  }

  set(key: string, nodes: AXNode[]): void {
    this.entries.set(key, { nodes, timestamp: Date.now() })
  }

  invalidate(key: string): void {
    this.entries.delete(key)
  }

  invalidateAll(): void {
    this.entries.clear()
  }
}
