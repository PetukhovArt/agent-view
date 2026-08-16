import type { FileChooserArm } from '../cdp/types.js'

/** What the arm script reports back from the page. */
export enum TauriShimResult {
  Armed = 'armed',
  /** The window is not a Tauri webview — nothing to patch, and nothing is wrong. */
  NoTauri = 'no-tauri',
}

export type TauriShimStatus = {
  patched: boolean
  armed: boolean
  fired: Array<{ ts: number; cmd: string; cancel: boolean }>
}

const STORE_KEY = '__agentViewTauriDialog__'

/**
 * Tauri opens its file dialog in Rust, past the webview, so CDP cannot see it
 * and cannot close it. The one seam is the JS side of the call:
 * `@tauri-apps/plugin-dialog` resolves `window.__TAURI_INTERNALS__.invoke` at
 * call time, so replacing that function answers the dialog before the Rust side
 * ever runs. The patch survives repeated arming but not a navigation — a fresh
 * document has a fresh `window`, and the window must be armed again.
 */
export function buildTauriArmScript(arm: FileChooserArm | null): string {
  return `(() => {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return ${JSON.stringify(TauriShimResult.NoTauri)};
  let store = window[${JSON.stringify(STORE_KEY)}];
  // Disarming a window that was never armed must not install the patch: a
  // command whose whole purpose is to remove interference cannot add some.
  if (!store && ${JSON.stringify(arm === null)}) return ${JSON.stringify(TauriShimResult.NoTauri)};
  if (!store) {
    store = window[${JSON.stringify(STORE_KEY)}] = { arm: null, fired: [] };
    const original = internals.invoke.bind(internals);
    internals.invoke = function (cmd, args, opts) {
      const arm = store.arm;
      if (arm && (cmd === 'plugin:dialog|open' || cmd === 'plugin:dialog|save')) {
        store.arm = null;
        store.fired.push({ ts: Date.now(), cmd: cmd, cancel: arm.kind === 'cancel' });
        if (store.fired.length > 20) store.fired.shift();
        if (arm.kind === 'cancel') return Promise.resolve(null);
        const multiple = cmd === 'plugin:dialog|open' && !!(args && args.options && args.options.multiple);
        return Promise.resolve(multiple ? arm.files : (arm.files[0] === undefined ? null : arm.files[0]));
      }
      return original(cmd, args, opts);
    };
  }
  store.arm = ${JSON.stringify(arm)};
  return ${JSON.stringify(TauriShimResult.Armed)};
})()`
}

export function buildTauriStatusScript(): string {
  return `(() => {
  const store = window[${JSON.stringify(STORE_KEY)}];
  return {
    patched: !!store,
    armed: !!(store && store.arm),
    fired: store ? store.fired : [],
  };
})()`
}
