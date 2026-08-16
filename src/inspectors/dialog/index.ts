import {
  type FileChooserArm,
  type FileChooserEvent,
  type JsDialogInfo,
  type JsDialogPolicy,
} from '../../cdp/types.js'

export type DialogStatus = {
  policy: JsDialogPolicy
  dialogs: JsDialogInfo[]
  chooserArm: FileChooserArm | null
  choosers: FileChooserEvent[]
  /** True when the Tauri dialog shim is installed in this window. */
  tauriPatched: boolean
  /** The shim holds its own arm inside the page, with its own lifetime. */
  tauriArmed: boolean
}

/** Human wording of the standing answer, for `dialog` output and command echoes. */
export function describePolicy(policy: JsDialogPolicy): string {
  if (!policy.accept) return 'dismiss'
  return policy.promptText === undefined ? 'accept' : `accept, prompt text "${policy.promptText}"`
}

export function describeArm(arm: FileChooserArm | null): string {
  if (!arm) return 'not armed'
  if (arm.kind === 'cancel') return 'armed: cancel'
  return `armed: ${arm.files.length} file(s) — ${arm.files.map(basename).join(', ')}`
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function describeAnswer(dialog: JsDialogInfo): string {
  const { answer } = dialog
  if (!answer) return 'OPEN — not answered'
  const verb = answer.accept ? 'accepted' : 'dismissed'
  const text = answer.promptText === undefined ? '' : ` "${answer.promptText}"`
  return `${verb}${text} (${answer.automatic ? 'auto' : 'manual'})`
}

function describeChooser(event: FileChooserEvent): string {
  if (event.answer === 'files') return `answered with ${event.files?.map(basename).join(', ') ?? ''}`
  if (event.answer === 'cancel') return event.matchedInput ? 'cancelled' : 'cancelled — no file input to fill'
  return 'not answered'
}

/**
 * `stamp` is injected rather than imported: the time format belongs to the log
 * feed, and inspectors must not depend on the server layer.
 */
export function formatDialogStatus(status: DialogStatus, stamp: (ts: number) => string): string {
  const lines = [`JS dialog policy: ${describePolicy(status.policy)}`]

  for (const dialog of status.dialogs) {
    const message = dialog.message ? ` "${dialog.message}"` : ''
    lines.push(`  ${stamp(dialog.ts)}  ${dialog.type}${message} → ${describeAnswer(dialog)}`)
  }
  if (status.dialogs.length === 0) {
    lines.push('  no JS dialog seen on this window yet')
  }

  const engines = status.tauriPatched ? 'CDP + Tauri IPC' : 'CDP'
  lines.push('', `File chooser (${engines}): ${describeArm(status.chooserArm)}`)
  if (status.tauriArmed) {
    lines.push('  Tauri IPC shim: armed in the page — survives a dropped session, not a navigation')
  }
  for (const chooser of status.choosers) {
    lines.push(`  ${stamp(chooser.ts)}  ${chooser.mode} → ${describeChooser(chooser)}`)
  }
  if (status.choosers.length === 0) {
    lines.push('  no file chooser intercepted on this window yet')
  }

  return lines.join('\n')
}
