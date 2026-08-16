import { describe, it, expect } from 'vitest'
import { formatDialogStatus, describePolicy, describeArm, type DialogStatus } from '../index.js'
import { FileChooserMode, JsDialogType, type JsDialogInfo } from '../../../cdp/types.js'

const stamp = (ts: number): string => `t+${ts}`

const emptyStatus: DialogStatus = {
  policy: { accept: false },
  dialogs: [],
  chooserArm: null,
  choosers: [],
  tauriPatched: false,
  tauriArmed: false,
}

describe('describePolicy', () => {
  it('names the dismiss default', () => {
    expect(describePolicy({ accept: false })).toBe('dismiss')
  })

  it('names accept, with the prompt text when one is set', () => {
    expect(describePolicy({ accept: true })).toBe('accept')
    expect(describePolicy({ accept: true, promptText: 'hi' })).toBe('accept, prompt text "hi"')
  })
})

describe('describeArm', () => {
  it('reports files by basename, not by full path', () => {
    expect(describeArm({ kind: 'files', files: ['C:\\tmp\\a.png', '/tmp/b.pdf'] }))
      .toBe('armed: 2 file(s) — a.png, b.pdf')
  })

  it('names the cancel and the disarmed states', () => {
    expect(describeArm({ kind: 'cancel' })).toBe('armed: cancel')
    expect(describeArm(null)).toBe('not armed')
  })
})

describe('formatDialogStatus', () => {
  it('says so when the window has seen nothing', () => {
    expect(formatDialogStatus(emptyStatus, stamp)).toBe([
      'JS dialog policy: dismiss',
      '  no JS dialog seen on this window yet',
      '',
      'File chooser (CDP): not armed',
      '  no file chooser intercepted on this window yet',
    ].join('\n'))
  })

  it('lists each dialog with how it was answered', () => {
    const dialogs: JsDialogInfo[] = [
      { ts: 1, type: JsDialogType.Confirm, message: 'Delete?', url: 'http://x', answer: { accept: false, automatic: true } },
      { ts: 2, type: JsDialogType.Prompt, message: 'Name', url: 'http://x', answer: { accept: true, promptText: 'test', automatic: false } },
    ]

    const out = formatDialogStatus({ ...emptyStatus, dialogs }, stamp)

    expect(out).toContain('  t+1  confirm "Delete?" → dismissed (auto)')
    expect(out).toContain('  t+2  prompt "Name" → accepted "test" (manual)')
  })

  // An unanswered row means the renderer is still blocked — it must not look
  // the same as an answered one.
  it('marks a dialog that is still open', () => {
    const dialogs: JsDialogInfo[] = [{ ts: 1, type: JsDialogType.Alert, message: '', url: 'http://x' }]

    expect(formatDialogStatus({ ...emptyStatus, dialogs }, stamp))
      .toContain('  t+1  alert → OPEN — not answered')
  })

  it('names both engines once the Tauri shim is installed', () => {
    const status: DialogStatus = { ...emptyStatus, tauriPatched: true, chooserArm: { kind: 'cancel' } }

    expect(formatDialogStatus(status, stamp)).toContain('File chooser (CDP + Tauri IPC): armed: cancel')
  })

  // The shim's arm lives in the page and outlives the session that set it, so
  // reporting only the CDP half would call a live arm "not armed".
  it('reports the shim arm separately from the CDP one', () => {
    const status: DialogStatus = { ...emptyStatus, tauriPatched: true, tauriArmed: true, chooserArm: null }

    const out = formatDialogStatus(status, stamp)

    expect(out).toContain('File chooser (CDP + Tauri IPC): not armed')
    expect(out).toContain('Tauri IPC shim: armed in the page')
  })

  // A chooser with no backing input can only be cancelled; that is a different
  // outcome from a cancel the caller asked for.
  it('separates a cancel that was asked for from one forced by a missing input', () => {
    const status: DialogStatus = {
      ...emptyStatus,
      choosers: [
        { ts: 1, mode: FileChooserMode.Single, matchedInput: true, answer: 'cancel' },
        { ts: 2, mode: FileChooserMode.Multiple, matchedInput: false, answer: 'cancel' },
        { ts: 3, mode: FileChooserMode.Single, matchedInput: true, answer: 'files', files: ['/tmp/a.png'] },
      ],
    }

    const out = formatDialogStatus(status, stamp)

    expect(out).toContain('  t+1  selectSingle → cancelled')
    expect(out).toContain('  t+2  selectMultiple → cancelled — no file input to fill')
    expect(out).toContain('  t+3  selectSingle → answered with a.png')
  })
})
