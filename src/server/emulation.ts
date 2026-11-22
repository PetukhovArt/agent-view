import { NO_EMULATION, isEmulating, type ColorScheme, type EmulationState, type PointerKind } from '../cdp/types.js'

export const MAX_EMULATED_PX = 10_000
export const MIN_EMULATED_SCALE = 0.1
export const MAX_EMULATED_SCALE = 10

export type EmulationRequest = {
  width?: number
  height?: number
  scale?: number
  colorScheme?: string
  pointer?: string
  reducedMotion?: boolean
  reset?: boolean
}

const COLOR_SCHEMES: readonly ColorScheme[] = ['light', 'dark']
const POINTERS: readonly PointerKind[] = ['fine', 'coarse']

const isPx = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= MAX_EMULATED_PX

export function mergeEmulation(current: EmulationState, request: EmulationRequest): EmulationState | { error: string } {
  const base = request.reset ? NO_EMULATION : current
  const { width, height, scale, colorScheme, pointer, reducedMotion } = request
  if (width !== undefined && !isPx(width)) return { error: `--width must be a whole number of CSS px from 1 to ${MAX_EMULATED_PX}, got ${width}` }
  if (height !== undefined && !isPx(height)) return { error: `--height must be a whole number of CSS px from 1 to ${MAX_EMULATED_PX}, got ${height}` }
  if (scale !== undefined && !(scale >= MIN_EMULATED_SCALE && scale <= MAX_EMULATED_SCALE)) {
    return { error: `--scale must be a device pixel ratio from ${MIN_EMULATED_SCALE} to ${MAX_EMULATED_SCALE}, got ${scale}` }
  }
  if (colorScheme !== undefined && !COLOR_SCHEMES.includes(colorScheme as ColorScheme)) return { error: `--color-scheme must be light or dark, got "${colorScheme}"` }
  if (pointer !== undefined && !POINTERS.includes(pointer as PointerKind)) return { error: `--pointer must be fine or coarse, got "${pointer}"` }
  return {
    width: width ?? base.width,
    height: height ?? base.height,
    scale: scale ?? base.scale,
    colorScheme: (colorScheme as ColorScheme | undefined) ?? base.colorScheme,
    pointer: (pointer as PointerKind | undefined) ?? base.pointer,
    reducedMotion: reducedMotion ?? base.reducedMotion,
  }
}

export function formatEmulation(state: EmulationState): string {
  if (!isEmulating(state)) return 'emulation: none'
  const parts = [
    state.width !== null && `width=${state.width}`,
    state.height !== null && `height=${state.height}`,
    state.scale !== null && `scale=${state.scale}`,
    state.colorScheme !== null && `color-scheme=${state.colorScheme}`,
    state.pointer !== null && `pointer=${state.pointer}`,
    state.reducedMotion && 'reduced-motion',
  ].filter(Boolean)
  return `emulation: ${parts.join(' ')}`
}
