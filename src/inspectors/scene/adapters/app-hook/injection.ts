import type { SceneGoto } from '../../types.js'

export const HOOK = '__AGENT_VIEW_SCENE__'

const NO_HOOK_YET = JSON.stringify({ error: `No window.${HOOK} on the page: the app sets it`, reason: 'missing' })

const callHook = (method: string, arg: unknown): string => `
(async function () {
  var hook = window.${HOOK};
  if (!hook || typeof hook.${method} !== 'function') return ${NO_HOOK_YET};
  try {
    return await hook.${method}(${JSON.stringify(arg)});
  } catch (e) {
    return { error: '${HOOK}.${method} threw: ' + (e && e.message || e), reason: 'fatal' };
  }
})()
`

export const APP_HOOK_EXTRACT_SCRIPT = `
(async function () {
  var hook = window.${HOOK};
  return hook && typeof hook.nodes === 'function' ? await hook.nodes() : null;
})()
`

export const appHookLocateScript = (query: string): string => callHook('locate', query)

export const appHookGotoScript = (target: SceneGoto): string => callHook('goto', target)
