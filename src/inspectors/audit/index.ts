import type { RuntimeSession } from '../../cdp/types.js'
import { capLines } from '../format.js'
import { collectScript } from './page-script.js'
import { runRules } from './rules.js'
import type { AuditMiss, AuditOptions, AuditResult, AuditSnapshot, Finding } from './types.js'

export { AUDIT_RULES, SCENE_RULES, DEFAULT_MIN_TARGET_PX, COARSE_MIN_TARGET_PX } from './types.js'
export type { AuditResult, AuditRule, AuditOptions, Finding, SceneRule } from './types.js'

export type PageAuditOptions = AuditOptions & { root?: string; testIdAttrs: readonly string[] }

const isMiss = (raw: unknown): raw is AuditMiss => typeof (raw as AuditMiss | null)?.error === 'string'

const isSnapshot = (raw: unknown): raw is AuditSnapshot => {
  const s = raw as Partial<AuditSnapshot> | null
  return Array.isArray(s?.nodes) && typeof s?.viewport?.width === 'number'
}

export function summarize(findings: Finding[], base: Omit<AuditResult, 'counts' | 'findings'>): AuditResult {
  const errors = findings.filter(f => f.severity === 'error').length
  return { ...base, counts: { error: errors, warn: findings.length - errors }, findings }
}

export async function auditPage(conn: RuntimeSession, options: PageAuditOptions): Promise<AuditResult | AuditMiss> {
  const raw = await conn.evaluate(collectScript({ root: options.root, testIdAttrs: options.testIdAttrs }), { awaitPromise: true })
  if (isMiss(raw)) return raw
  if (!isSnapshot(raw)) return { error: `Unexpected answer from the page: ${JSON.stringify(raw)?.slice(0, 200)}` }
  return summarize(runRules(raw, options), {
    viewport: raw.viewport,
    coarsePointer: raw.coarse,
    scanned: raw.nodes.length,
    truncated: raw.truncated,
  })
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

function describeFinding(f: Finding): string {
  const { target, rect } = f
  const who = [target.role, target.name ?? target.text ? `"${target.name ?? target.text}"` : undefined, target.testid ? `testid=${target.testid}` : undefined]
    .filter(Boolean).join(' ')
  return `${f.severity.padEnd(5)} ${f.rule} ${who || target.selector} @${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}x${Math.round(rect.height)} — ${f.detail}${target.testid ? '' : ` selector=${target.selector}`}`
}

export function formatAudit(result: AuditResult, maxLines?: number): string {
  const { counts, findings, viewport } = result
  const where = `${viewport.width}x${viewport.height} viewport, ${plural(result.scanned, 'element')}${result.truncated ? ' (the rest of the page was not scanned)' : ''}`
  const summary = findings.length === 0
    ? `audit: no findings, ${where}`
    : `audit: ${plural(counts.error, 'error')}, ${plural(counts.warn, 'warning')}, ${where}`
  const lines = findings.map(describeFinding)
  const body = capLines(lines, maxLines)
  return body ? `${body}\n${summary}` : summary
}

export const hasErrors = (result: AuditResult): boolean => result.counts.error > 0

