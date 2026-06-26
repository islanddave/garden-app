// Shared resvg render + ink-coverage helper for the V4-ICON-001 optical-weight + seam gates.
// Engine = @resvg/resvg-js (deterministic, no browser). currentColor is substituted to an
// opaque ink for measurement (coverage is color-agnostic). Live area = the 20x20 keyline-safe
// region (2..22 in 24-space), per V101 §2/§14.
import { Resvg } from '@resvg/resvg-js'
export const REND = 240, SCALE = REND / 24
export const LIVE_LO = Math.round(2 * SCALE), LIVE_HI = Math.round(22 * SCALE)

export function renderInner(inner, { ink = '#000', strokeWidth = 1.75, fills = null } = {}) {
  let m = inner.replaceAll('currentColor', ink)
  if (fills) for (const [region, color] of Object.entries(fills)) {
    m = m.replace(new RegExp(`(data-region="${region}"[^>]*?)(fill|stroke)="#000"`, 'g'), `$1$2="${color}"`)
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${REND}" height="${REND}" viewBox="0 0 24 24" fill="none" stroke="${ink}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${m}</svg>`
  const png = new Resvg(svg, { background: 'rgba(255,255,255,0)' }).render()
  return { data: png.pixels, W: png.width, H: png.height }
}

export function liveCoverage(inner, opts) {
  const { data, W } = renderInner(inner, opts)
  let o = 0, t = 0
  for (let y = LIVE_LO; y < LIVE_HI; y++) for (let x = LIVE_LO; x < LIVE_HI; x++) { t++; if (data[(y * W + x) * 4 + 3] > 128) o++ }
  return +(100 * o / t).toFixed(2)
}
