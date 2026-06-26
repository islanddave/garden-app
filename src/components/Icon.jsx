// src/components/Icon.jsx — V4-ICON-001 (Pass B V101) single icon render surface.
// Registry-driven (getIcon). Selects 24/18 master at the §2 crossover, computes the
// §4 effective stroke (size-aware so the RENDERED width holds), forks mono(currentColor)
// vs color-candidate(authored fills), a11y-correct (role=img+label OR aria-hidden).
// Hit-area / role=button / aria-pressed / aria-current belong to the CONSUMING control.
import React from 'react'
import { getIcon } from '../lib/iconRegistry.js'
import { ICON } from '../lib/tokens.js'

export default function Icon({ name, size = 24, title, decorative = false, variant, surface = 'cream', className, style }) {
  const base = getIcon(name)
  const v = (variant && base.variants && base.variants[variant]) ? { ...base, ...base.variants[variant] } : base
  const markup = (size >= 21 ? v.svg24 : (v.svg18 || v.svg24))
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
