import { TargetType } from '../cdp/types.js'

/** URLs a Chromium runtime exposes as CDP page-targets but that aren't app windows. */
const INTERNAL_URL_PATTERNS = [
  'about:blank',
  'devtools://',
  'chrome-extension://',
]

/**
 * True for a page-target that is an actual app window — filters out the DevTools
 * frontend (`devtools://`), which registers as a first-in-list `page` target the
 * moment a user opens DevTools and would otherwise be picked as the default window.
 */
export function isAppTarget(target: { type: string; url: string; title: string }): boolean {
  if (target.type !== TargetType.Page) return false
  const url = target.url.toLowerCase()
  return !INTERNAL_URL_PATTERNS.some(pattern => url.startsWith(pattern))
}
