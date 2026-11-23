export type Box = { x: number; y: number; width: number; height: number }

export type Rgba = { r: number; g: number; b: number; a: number }

export type Overflow = 'visible' | 'hidden' | 'clip' | 'scroll' | 'auto'

export type AuditTarget = {
  testid?: string
  role?: string
  name?: string
  text?: string
  selector: string
}

export type AuditNode = {
  parent: number
  tag: string
  rect: Box
  textRect: Box | null
  ownText: boolean
  interactive: boolean
  replaced: boolean
  disabled: boolean
  visible: boolean
  opacity: number
  position: string
  overflowX: Overflow
  overflowY: Overflow
  clipBox: Box | null
  scrollArea: Box | null
  ellipsis: boolean
  lineClamp: boolean
  scroll: { width: number; clientWidth: number; height: number; clientHeight: number } | null
  stacking: boolean
  containingBlock: boolean
  transformed: boolean
  layer: boolean
  dialog: boolean
  fixed: boolean
  inline: boolean
  pointerEvents: boolean
  labelRect: Box | null
  color: Rgba | null
  background: Rgba | null
  backgroundImage: boolean
  backgroundClipText: boolean
  fontSize: number
  fontWeight: number
  inRoot: boolean
  target: AuditTarget | null
}

export type AuditSnapshot = {
  viewport: { width: number; height: number }
  coarse: boolean
  canvas: Rgba
  nodes: AuditNode[]
  truncated: boolean
}

export type AuditMiss = { error: string }

export const AUDIT_RULES = ['offscreen', 'clipped', 'text-clip', 'overlap', 'target-size', 'contrast'] as const
export type AuditRule = typeof AUDIT_RULES[number]

export const SCENE_RULES = ['scene-text-out', 'scene-overlap', 'scene-offscreen'] as const
export type SceneRule = typeof SCENE_RULES[number]

export type Severity = 'error' | 'warn'

export type Finding = {
  rule: AuditRule | SceneRule
  severity: Severity
  target: AuditTarget
  rect: Box
  detail: string
}

export type AuditOptions = {
  rules?: readonly AuditRule[]
  minTarget?: number
}

export const DEFAULT_MIN_TARGET_PX = 24
export const COARSE_MIN_TARGET_PX = 44

export type AuditResult = {
  viewport: { width: number; height: number }
  coarsePointer: boolean
  scanned: number
  truncated: boolean
  counts: { error: number; warn: number }
  findings: Finding[]
}
