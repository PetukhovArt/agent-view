import { describe, it, expect, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
import { buildTauriArmScript, buildTauriStatusScript, TauriShimResult } from './tauri-dialog-shim.js'
import type { FileChooserArm } from '../cdp/types.js'

type Invoke = (cmd: string, args?: unknown, opts?: unknown) => Promise<unknown>

function tauriWindow(original: Invoke): { window: Record<string, unknown> } {
  return { window: { __TAURI_INTERNALS__: { invoke: original } } }
}

function arm(sandbox: object, value: FileChooserArm | null): unknown {
  return runInNewContext(buildTauriArmScript(value), sandbox)
}

function invokeOf(sandbox: { window: Record<string, unknown> }): Invoke {
  return (sandbox.window.__TAURI_INTERNALS__ as { invoke: Invoke }).invoke
}

describe('buildTauriArmScript', () => {
  it('reports no-tauri and patches nothing in a plain webview', () => {
    const sandbox = { window: {} }

    expect(arm(sandbox, { kind: 'cancel' })).toBe(TauriShimResult.NoTauri)
    expect(sandbox.window).toEqual({})
  })

  it('answers plugin:dialog|open with a single path', async () => {
    const original = vi.fn<Invoke>()
    const sandbox = tauriWindow(original)
    arm(sandbox, { kind: 'files', files: ['C:\\tmp\\a.png'] })

    const result = await invokeOf(sandbox)('plugin:dialog|open', { options: { multiple: false } })

    expect(result).toBe('C:\\tmp\\a.png')
    expect(original).not.toHaveBeenCalled()
  })

  // The plugin returns an array only when the call asked for multiple, and the
  // app branches on that shape — a single path in an array would break it.
  it('answers with an array only when the call asked for multiple', async () => {
    const sandbox = tauriWindow(vi.fn<Invoke>())
    arm(sandbox, { kind: 'files', files: ['/tmp/a.png', '/tmp/b.png'] })

    const result = await invokeOf(sandbox)('plugin:dialog|open', { options: { multiple: true } })

    expect(result).toEqual(['/tmp/a.png', '/tmp/b.png'])
  })

  it('answers a cancel with null, which is how the plugin reports it', async () => {
    const sandbox = tauriWindow(vi.fn<Invoke>())
    arm(sandbox, { kind: 'cancel' })

    await expect(invokeOf(sandbox)('plugin:dialog|save', { options: {} })).resolves.toBeNull()
  })

  // Arming is one-shot: a standing intercept would keep changing behaviour long
  // after the command that set it.
  it('passes the call through once it has fired', async () => {
    const original = vi.fn<Invoke>().mockResolvedValue('real')
    const sandbox = tauriWindow(original)
    arm(sandbox, { kind: 'files', files: ['/tmp/a.png'] })

    await invokeOf(sandbox)('plugin:dialog|open', { options: {} })
    const second = await invokeOf(sandbox)('plugin:dialog|open', { options: {} })

    expect(second).toBe('real')
    expect(original).toHaveBeenCalledOnce()
  })

  it('never touches commands other than the dialog plugin', async () => {
    const original = vi.fn<Invoke>().mockResolvedValue('real')
    const sandbox = tauriWindow(original)
    arm(sandbox, { kind: 'files', files: ['/tmp/a.png'] })

    await expect(invokeOf(sandbox)('plugin:fs|read_file', {})).resolves.toBe('real')
  })

  it('re-arms the existing patch instead of stacking a second one', async () => {
    const original = vi.fn<Invoke>().mockResolvedValue('real')
    const sandbox = tauriWindow(original)
    arm(sandbox, { kind: 'files', files: ['/tmp/a.png'] })
    const afterFirst = invokeOf(sandbox)
    arm(sandbox, { kind: 'files', files: ['/tmp/b.png'] })

    expect(invokeOf(sandbox)).toBe(afterFirst)
    await expect(invokeOf(sandbox)('plugin:dialog|open', { options: {} })).resolves.toBe('/tmp/b.png')
  })

  it('lets calls through again after being disarmed', async () => {
    const original = vi.fn<Invoke>().mockResolvedValue('real')
    const sandbox = tauriWindow(original)
    arm(sandbox, { kind: 'files', files: ['/tmp/a.png'] })
    arm(sandbox, null)

    await expect(invokeOf(sandbox)('plugin:dialog|open', { options: {} })).resolves.toBe('real')
  })
})

describe('buildTauriStatusScript', () => {
  it('reports an unpatched window', () => {
    expect(runInNewContext(buildTauriStatusScript(), { window: {} }))
      .toEqual({ patched: false, armed: false, fired: [] })
  })

  it('reports the patch and what it has answered', async () => {
    const sandbox = tauriWindow(vi.fn<Invoke>())
    arm(sandbox, { kind: 'cancel' })
    await invokeOf(sandbox)('plugin:dialog|open', { options: {} })

    const status = runInNewContext(buildTauriStatusScript(), sandbox) as {
      patched: boolean
      armed: boolean
      fired: Array<{ cmd: string; cancel: boolean }>
    }

    expect(status.patched).toBe(true)
    expect(status.armed).toBe(false)
    expect(status.fired).toEqual([expect.objectContaining({ cmd: 'plugin:dialog|open', cancel: true })])
  })
})

describe('disarm on an untouched window', () => {
  // A command whose purpose is to remove interference must not add some.
  it('does not install the patch when nothing was ever armed', () => {
    const original = vi.fn<Invoke>()
    const sandbox = tauriWindow(original)

    expect(arm(sandbox, null)).toBe(TauriShimResult.NoTauri)
    expect(invokeOf(sandbox)).toBe(original)
    expect(runInNewContext(buildTauriStatusScript(), sandbox))
      .toEqual({ patched: false, armed: false, fired: [] })
  })

  it('still disarms a window that was armed before', async () => {
    const original = vi.fn<Invoke>().mockResolvedValue('real')
    const sandbox = tauriWindow(original)
    arm(sandbox, { kind: 'files', files: ['/tmp/a.png'] })

    expect(arm(sandbox, null)).toBe(TauriShimResult.Armed)
    await expect(invokeOf(sandbox)('plugin:dialog|open', { options: {} })).resolves.toBe('real')
  })
})
