// src/__tests__/iconColorNav.test.jsx
//
// V4-ICONCOLOR-001 tab-bar pass (Dave 2026-08-28) — gates for the four `filled` colour variants.
//
// WHY THIS FILE EXISTS AT ALL. Commit 0bddf91 replaced the 🧺 and 🫙 emoji on the Harvests and
// Put-Up tabs with mono line art, for set-completeness. Nothing was wrong with the code and every
// test stayed green, because no test had an opinion about whether the bar carried colour — so the
// only two coloured tabs were levelled DOWN and it took Dave noticing on his phone to surface it.
// These gates give that property a place to live.
//
// THE FOUR FAILURE MODES THEY EXIST FOR, each of which is silent:
//   1. A colour region declared against markup that has no such [data-region] — the colour is
//      simply never applied and the glyph renders mono. Nothing errors.
//   2. A colorFills token that is not in ICON_COLORS — applyRegionColor's `if (!hex) continue`
//      skips it, so a typo'd token name is indistinguishable from mono at runtime.
//   3. A colour under the 3:1 silhouette floor. Two candidates were rejected for exactly this while
//      drawing these (P.sage at 2.89:1 for the checklist rows, a #cfe0ef pale-glass jar body at
//      1.24:1) — measured, not eyeballed, and this is what keeps the next one measured too.
//   4. A base entry quietly becoming a color-candidate. nav.garden is ALSO potting_up on the plant
//      timeline (iconEvents.js), so a base change colours a surface nobody asked to change.
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { getIcon } from '../lib/iconRegistry.js'
import { ICON_COLORS } from '../lib/tokens.js'
import Icon from '../components/Icon.jsx'

const TAB_ICONS = ['nav.today', 'nav.garden', 'nav.harvests', 'nav.putup']
const CREAM = '#f8f5f0'

// WCAG relative luminance / contrast, so the floor is computed rather than asserted from a comment.
const lin = (c) => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
const lum = (hex) => {
  const h = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

const markupOf = (name, variant) => {
  const { container } = render(<Icon name={name} variant={variant} size={24} decorative />)
  const html = container.querySelector('svg').innerHTML
  cleanup()
  return html
}

describe('V4-ICONCOLOR-001 — bottom-bar filled variants', () => {
  it.each(TAB_ICONS)('%s carries a filled variant that is a color-candidate', (name) => {
    const e = getIcon(name)
    expect(e.variants?.filled).toBeTruthy()
    expect(e.variants.filled.class).toBe('color-candidate')
    expect(e.colorFills).toBeTruthy()
  })

  // Failure mode 4. The base must stay mono or potting_up changes colour on the plant timeline.
  it.each(TAB_ICONS)('%s BASE stays mono, so non-tab consumers are untouched', (name) => {
    expect(getIcon(name).class).toBe('mono')
    expect(markupOf(name)).not.toMatch(/#[0-9a-f]{6}/i)
  })

  it.each(TAB_ICONS)('%s filled resolves every region to a real hex', (name) => {
    const html = markupOf(name, 'filled')
    const regions = Object.keys(getIcon(name).colorFills)
    for (const r of regions) {
      const el = new RegExp(`data-region="${r}"[^>]*?(?:fill|stroke)="(#[0-9a-f]{6})"`, 'i')
      expect(html, `region "${r}" of ${name} never got a hex`).toMatch(el)
    }
    // No region may be left on currentColor — that IS the silent mono fallback (failure mode 2
    // seen from the render side rather than the registry side).
    const stranded = [...html.matchAll(/data-region="([^"]+)"[^>]*?(?:fill|stroke)="currentColor"/g)]
      .map(m => m[1])
    expect(stranded, `${name} left these regions on currentColor`).toEqual([])
  })

  // Failure mode 1: a colour declared against markup that does not contain that region.
  it.each(TAB_ICONS)('%s declares no colour region that the markup lacks, at 24 AND 18', (name) => {
    const e = getIcon(name)
    const declared = Object.keys(e.colorFills)
    for (const master of ['svg24', 'svg18']) {
      const present = new Set([...e.variants.filled[master].matchAll(/data-region="([^"]+)"/g)].map(m => m[1]))
      for (const r of present) {
        expect(declared, `${name}.${master} draws region "${r}" with no colorFills entry`).toContain(r)
      }
      expect(present.size, `${name}.${master} has no coloured regions at all`).toBeGreaterThan(0)
    }
  })

  // Failure mode 2: a token name that is not in ICON_COLORS renders mono and says nothing.
  it.each(TAB_ICONS)('%s maps every region to a token that exists', (name) => {
    for (const [region, token] of Object.entries(getIcon(name).colorFills)) {
      expect(ICON_COLORS[token], `${name}.${region} -> "${token}" is not in ICON_COLORS`).toBeTruthy()
    }
  })

  // Failure mode 3: the silhouette floor. This is the gate that rejected two real candidates.
  it.each(TAB_ICONS)('%s uses only colours at or above the 3:1 floor on cream', (name) => {
    for (const [region, token] of Object.entries(getIcon(name).colorFills)) {
      const ratio = contrast(ICON_COLORS[token], CREAM)
      expect(ratio, `${name}.${region} (${token} ${ICON_COLORS[token]}) is ${ratio.toFixed(2)}:1 on cream`)
        .toBeGreaterThanOrEqual(3)
    }
  })
})
