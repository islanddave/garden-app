// src/components/Icon.jsx — V4-ICON-001 (Pass B V101) + V4-ICONCOLOR-001 single icon render surface.
// Registry-driven (getIcon). Selects 24/18 master at the §2 crossover, computes the §4
// effective stroke (size-aware so the RENDERED width holds), forks mono(currentColor) vs
// color-candidate(authored fills). COLOR PASS (V4-ICONCOLOR-001): for a color-candidate
// entry whose markup declares [data-region] fills, on the non-inverting 'cream' surface
// with color enabled, each region's fill|stroke="currentColor" is substituted with the
// resolved hex from ICON_COLORS via the entry's colorFills:{region:tokenName} map — the
// registry stays hex-free (runtime twin of scripts/icon-ci/_render.mjs). On the 'inverse'
// surface (green nav / on-photo) color is FORBIDDEN: regions fall back to mono (white
// currentColor line). Color is ADDITIVE to shape+label, never the sole channel (SC 1.4.1).
// Hit-area / role=button / aria-pressed / aria-current belong to the CONSUMING control.
import React from 'react'
import { getIcon } from '../lib/iconRegistry.js'
import { ICON, ICON_COLORS } from '../lib/tokens.js'

// Substitute fill|stroke="currentColor" -> resolved hex on each [data-region] element,
// per the entry's colorFills:{region:tokenName} map. Mirrors _render.mjs's region swap.
function applyRegionColor(markup, colorFills) {
  if (!colorFills) return markup
  let m = markup
  for (const [region, token] of Object.entries(colorFills)) {
    const hex = ICON_COLORS[token]
    if (!hex) continue
    m = m.replace(new RegExp(`(data-region="${region}"[^>]*?)(fill|stroke)="currentColor"`, 'g'), `$1$2="${hex}"`)
  }
  return m
}

export default function Icon({ name, size = 24, title, decorative = false, variant, surface = 'cream', color = 'auto', className, style }) {
  const base = getIcon(name)
  const v = (variant && base.variants && base.variants[variant]) ? { ...base, ...base.variants[variant] } : base
  let markup = (size >= 21 ? v.svg24 : (v.svg18 || v.svg24))
  // Color gate: color-candidate + color not disabled + non-inverting (cream) surface only.
  const colorOn = color !== false && v.class === 'color-candidate' && surface === 'cream'
  if (colorOn) markup = applyRegionColor(markup, v.colorFills)
  const target = size >= 32 ? ICON.strokeHero : surface === 'inverse' ? ICON.strokeInverse : size <= 23 ? ICON.strokeSmall : ICON.stroke
  const strokeWidth = Math.max(ICON.minStroke, target) * 24 / size
  const named = typeof v.accessibleName === 'string' ? v.accessibleName : null
  const label = title || named
  const a11y = (!decorative && label) ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style} {...a11y}
      dangerouslySetInnerHTML={{ __html: markup }} />
  )
}
