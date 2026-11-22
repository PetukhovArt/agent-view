import { describe, it, expect, vi } from 'vitest'
import { mergeEmulation } from './emulation.js'
import { NO_EMULATION, TargetType, type EmulationState, type PageSession } from '../cdp/types.js'
import { AgentViewServer } from './server.js'
import { RuntimeType } from '../types.js'

const phone: EmulationState = { width: 390, height: 844, scale: 2, colorScheme: 'dark', pointer: 'coarse', reducedMotion: true }

const adapter = vi.hoisted(() => ({ connect: vi.fn() }))
vi.mock('../adapters/registry.js', () => ({ getAdapter: () => adapter }))

describe('mergeEmulation', () => {
  it('keeps what the request does not name, and reset drops it first', () => {
    expect(mergeEmulation(phone, { colorScheme: 'light' })).toEqual({ ...phone, colorScheme: 'light' })
    expect(mergeEmulation(phone, { reset: true, width: 600 })).toEqual({ ...NO_EMULATION, width: 600 })
  })

  it('refuses a width the CDP override would turn into no override', () => {
    expect(mergeEmulation(NO_EMULATION, { width: 0 })).toHaveProperty('error')
  })
})

describe('emulation on a re-created session', () => {
  const target = { id: 'main-0000', type: TargetType.Page, title: 'App', url: 'app://index.html' }

  it('is applied again to the session that replaces an evicted one', async () => {
    const sessions: PageSession[] = []
    adapter.connect.mockImplementation(async () => {
      const session = { target, applyEmulation: vi.fn().mockResolvedValue(undefined), onDisconnect: vi.fn(), close: vi.fn().mockResolvedValue(undefined) } as unknown as PageSession
      sessions.push(session)
      return session
    })
    const server = new AgentViewServer() as unknown as {
      emulations: Map<string, EmulationState>
      getPageSession: (req: unknown, targetId: string) => Promise<PageSession>
      evictSession: (key: string) => void
    }
    const req = { port: 9222, runtime: RuntimeType.Browser }

    await server.getPageSession(req, target.id)
    expect(sessions[0].applyEmulation).not.toHaveBeenCalled()

    server.emulations.set(`9222:${target.id}`, phone)
    server.evictSession(`9222:${target.id}`)
    await server.getPageSession(req, target.id)
    expect(sessions[1].applyEmulation).toHaveBeenCalledWith(phone)
  })
})
