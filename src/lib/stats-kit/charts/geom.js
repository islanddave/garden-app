// Shared chart geometry. Every chart is drawn on a W-unit-wide viewBox and scaled to the card, so at a
// 426 CSS px phone (about 394 px of card) one unit is about one pixel and FS-unit labels stay legible.
import { isNum } from '../format.js'

export const W = 400
export const FS = 12
export const FS_SM = 11

// Linear scale d0..d1 -> r0..r1. A zero-width domain maps everything to the range start, and a
// non-number maps to r0, so no attribute can ever carry NaN.
export function linear(d0, d1, r0, r1) {
  const span = d1 - d0
  const f = (x) => {
    if (!isNum(x) || !isNum(span) || span === 0) return r0
    return r0 + ((x - d0) / span) * (r1 - r0)
  }
  f.domain = [d0, d1]
  f.range = [r0, r1]
  return f
}

// A round top for an axis: the smallest step multiple at or above max (and at least one step).
export function niceMax(max, step) {
  if (!isNum(max) || max <= 0) return step
  return Math.ceil(max / step) * step
}

export function ticks(max, step) {
  const out = []
  for (let t = 0; t <= max + 1e-9; t += step) out.push(Number(t.toFixed(6)))
  return out
}

// Fixed-point attribute value — stable output and short markup.
export const f1 = (n) => (isNum(n) ? Math.round(n * 10) / 10 : 0)

export const truncate = (s, n) => {
  const str = String(s ?? '')
  return str.length > n ? `${str.slice(0, n - 1)}…` : str
}

export const svgText = { fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }
