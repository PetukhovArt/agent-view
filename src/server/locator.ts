import type { PageSession } from '../cdp/types.js'

/**
 * Attributes tried when `testIdAttribute` is not configured, in order. Projects
 * rarely set more than one, so accepting all of them spares every project the
 * config line.
 */
const DEFAULT_TEST_ID_ATTRIBUTES = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'] as const

export function testIdAttributes(configured: string | undefined): readonly string[] {
  // The DOM reports attribute names lowercased; a camel-cased config would match nothing.
  return configured ? [configured.toLowerCase()] : DEFAULT_TEST_ID_ATTRIBUTES
}

export type Locator = { css: string; label: string }

export function locatorFromArgs(args: Record<string, unknown>): Locator | undefined {
  const { testid, selector, testIdAttribute } = args
  if (typeof testid === 'string') return testIdLocator(testid, typeof testIdAttribute === 'string' ? testIdAttribute : undefined)
  return typeof selector === 'string' ? { css: selector, label: `selector "${selector}"` } : undefined
}

export function testIdLocator(testid: string, testIdAttribute: string | undefined): Locator {
  const value = `"${testid.replace(/["\\]/g, '\\$&')}"`
  return { css: testIdAttributes(testIdAttribute).map(attr => `[${attr}=${value}]`).join(','), label: `testid "${testid}"` }
}

/**
 * The first visible element a locator names. The label says when it was one of
 * several, since acting on the first of many usually means the locator is too broad.
 */
export async function findByLocator(
  conn: PageSession,
  locator: Locator,
): Promise<{ backendDOMNodeId: number; label: string } | { error: string }> {
  const { backendDOMNodeId, count } = await conn.queryVisible(locator.css)
  if (count === 0) return { error: `No element matches ${locator.label}` }
  if (backendDOMNodeId === null) return { error: `None of ${count} element(s) matching ${locator.label} is visible` }
  return { backendDOMNodeId, label: count > 1 ? `${locator.label} (first visible of ${count})` : locator.label }
}
