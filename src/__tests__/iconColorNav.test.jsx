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

// V5-NAVCUSTOM-001 — action.pin, the More sheet's pin button. Same four silent failure modes as the
// tab glyphs above, plus the one this mark was drawn to avoid: converging on facet.location, the
// map-marker pin that sits a few rows away on the same sheet (Zones).
describe('V5-NAVCUSTOM-001 — action.pin: outline = not pinned, colour = pinned', () => {
  const WHITE = '#ffffff'
  const pin = getIcon('action.pin')

  it('base is a mono outline and `filled` is a colour-candidate (only the pinned state is coloured)', () => {
    expect(pin.class).toBe('mono')
    expect(markupOf('action.pin')).not.toMatch(/#[0-9a-f]{6}/i)
    expect(pin.variants?.filled?.class).toBe('color-candidate')
    expect(pin.accessibleName).toEqual({ outline: 'Pin to the top', filled: 'Unpin' })
  })

  // KILLING MUTATION: typo a colorFills token ('pinHed') or drop a region's data-region attribute.
  // RESULT: RED — the pinned state would render mono and read as "not pinned".
  it('filled resolves every region to a real hex, at 24 AND 18', () => {
    for (const size of [24, 18]) {
      const { container } = render(<Icon name="action.pin" variant="filled" size={size} decorative />)
      const html = container.querySelector('svg').innerHTML
      cleanup()
      for (const r of Object.keys(pin.colorFills)) {
        expect(html, `${size}: region "${r}" never got a hex`).toMatch(new RegExp(`data-region="${r}"[^>]*?(?:fill|stroke)="#[0-9a-f]{6}"`, 'i'))
      }
      expect(html).not.toMatch(/data-region="[^"]+"[^>]*?(?:fill|stroke)="currentColor"/)
    }
  })

  it('maps every region to a token that exists, at or above 3:1 on the sheet’s white and on cream', () => {
    for (const [region, token] of Object.entries(pin.colorFills)) {
      expect(ICON_COLORS[token], `${region} -> ${token}`).toBeTruthy()
      for (const bg of [WHITE, CREAM]) {
        expect(contrast(ICON_COLORS[token], bg), `${region} on ${bg}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it('the two states differ by SHAPE, not only hue — and the mark is not the map-marker pin', () => {
    const decolour = (h) => h.replace(/#[0-9a-f]{6}/gi, 'currentColor')
    expect(decolour(markupOf('action.pin', 'filled'))).not.toBe(markupOf('action.pin'))
    expect(pin.svg24).not.toBe(getIcon('facet.location').svg24)
    expect(pin.svg18).not.toBe(getIcon('facet.location').svg18)
  })
})

// V5-TODAYREDESIGN-001 — the three glyphs the Today jump bar draws that were still mono (Feed, Check,
// Protect), raised to colour so the bar follows Dave's 2026-08-28 rule. The four silent failure modes
// at the top of this file apply unchanged; this block adds the two this pass introduced:
//   5. Two of the three are event.* keys, and EVENT_GLYPHS built every event entry from its two masters
//      alone — a variant drawn on the form but not carried onto the key renders MONO, and nothing fails.
//   6. The bar draws them on WHITE chips over a cream bar, so the floor is measured on both surfaces.
// The bar renders them at 18 px, so the 18 master is the one that ships; every case runs 24 AND 18.
describe('V5-TODAYREDESIGN-001 — jump-bar glyphs raised to colour', () => {
  const TODAY_ICONS = ['care.feed', 'event.observation', 'event.brought_inside']
  const WHITE = '#ffffff'
  // A region a master drops on purpose, per its own comment in the registry. Anything else declared
  // but missing from a master is a region that silently never paints.
  const DROPPED = { 'care.feed': { svg18: ['vein'] } }
  const filledAt = (name, size) => {
    const { container } = render(<Icon name={name} variant="filled" size={size} decorative />)
    const html = container.querySelector('svg').innerHTML
    cleanup()
    return html
  }

  // Failure mode 4, as for the tabs: event.fertilizing draws care.feed's masters, and the two event
  // keys are timeline rows, so a base that turned colour would repaint surfaces nobody asked about.
  it.each(TODAY_ICONS)('%s BASE stays mono and draws no hex at 24 or 18', (name) => {
    expect(getIcon(name).class).toBe('mono')
    for (const size of [24, 18]) {
      const { container } = render(<Icon name={name} size={size} decorative />)
      expect(container.querySelector('svg').innerHTML, `${name} @${size}`).not.toMatch(/#[0-9a-f]{6}/i)
      cleanup()
    }
  })

  // Failure mode 5. KILLING MUTATION: drop `...colourOf(t)` from EVENT_GLYPHS in iconEvents.js.
  // RESULT: RED here for both event keys (and in every case below that renders them).
  it.each(TODAY_ICONS)('%s carries its `filled` colour-candidate variant on the key the bar names', (name) => {
    const e = getIcon(name)
    expect(e.variants?.filled?.class, `${name} has no filled colour variant`).toBe('color-candidate')
    expect(Object.keys(e.colorFills ?? {}).length).toBeGreaterThanOrEqual(2)
    expect(Object.keys(e.regionIntent ?? {})).toEqual(Object.keys(e.colorFills))
  })

  // Failure modes 1 + 2 from the render side. No currentColor may survive ANYWHERE in the filled
  // markup — stronger than "no region left on currentColor", because an element that lost its
  // data-region keeps currentColor and is invisible to a region-scoped scan.
  it.each(TODAY_ICONS)('%s filled paints every element with a real hex at 24 AND 18', (name) => {
    for (const size of [24, 18]) {
      const html = filledAt(name, size)
      for (const r of Object.keys(getIcon(name).colorFills)) {
        if (DROPPED[name]?.[size >= 21 ? 'svg24' : 'svg18']?.includes(r)) continue
        expect(html, `${name} @${size}: region "${r}" never got a hex`)
          .toMatch(new RegExp(`data-region="${r}"[^>]*?(?:fill|stroke)="#[0-9a-f]{6}"`, 'i'))
      }
      expect(html, `${name} @${size} left something on currentColor`).not.toMatch(/currentColor/)
    }
  })

  // Failure mode 1 in both directions: every drawn region is declared, and every declared region is
  // drawn except the documented drops — so a region cannot quietly stop painting at the ship size.
  it.each(TODAY_ICONS)('%s declared regions and drawn regions agree at 24 AND 18', (name) => {
    const e = getIcon(name)
    const declared = Object.keys(e.colorFills).sort()
    for (const master of ['svg24', 'svg18']) {
      const drawn = [...new Set([...e.variants.filled[master].matchAll(/data-region="([^"]+)"/g)].map(m => m[1]))].sort()
      const dropped = DROPPED[name]?.[master] ?? []
      expect(drawn, `${name}.${master}`).toEqual(declared.filter(r => !dropped.includes(r)))
    }
  })

  // Failure modes 2, 3 and 6. KILLING MUTATIONS: typo a colorFills token ('eyeIriss'), or set
  // houseWall to a pale brick ('#e0b8a0', 1.8:1). RESULT: RED on the token or the floor.
  it.each(TODAY_ICONS)('%s maps every region to a real token at or above 3:1 on cream AND on white', (name) => {
    for (const [region, token] of Object.entries(getIcon(name).colorFills)) {
      expect(ICON_COLORS[token], `${name}.${region} -> "${token}" is not in ICON_COLORS`).toBeTruthy()
      for (const bg of [CREAM, WHITE]) {
        const ratio = contrast(ICON_COLORS[token], bg)
        expect(ratio, `${name}.${region} (${token} ${ICON_COLORS[token]}) is ${ratio.toFixed(2)}:1 on ${bg}`)
          .toBeGreaterThanOrEqual(3)
      }
    }
  })

  // The variant has to be a drawing in its own right, not the mono master with hex swapped in: the
  // mono outlines leave enclosed empty interiors (the eye's white, the house's rooms), which the
  // region-seam gate rejects for a colour glyph, and a stroked outline in colour is not what "raise to
  // colour" means next to Harvest and Put-Up.
  // Compared as GEOMETRY (path data and circle placement), not markup: adding data-region attributes to
  // the mono paths would change the markup and pass a markup comparison while drawing the same outline.
  it.each(TODAY_ICONS)('%s filled is a different drawing from its mono base at 24 AND 18', (name) => {
    const geometry = (m) => [...m.matchAll(/\b(d|cx|cy|r)="([^"]+)"/g)].map(x => x[0]).join(' ')
    const e = getIcon(name)
    for (const master of ['svg24', 'svg18']) {
      expect(geometry(e.variants.filled[master]), `${name}.${master}`).not.toBe(geometry(e[master]))
    }
  })

  it('the three are three different marks with three different colour sets', () => {
    const sets = TODAY_ICONS.map(n => Object.values(getIcon(n).colorFills).map(t => ICON_COLORS[t]).sort().join())
    expect(new Set(sets).size).toBe(3)
    expect(new Set(TODAY_ICONS.map(n => filledAt(n, 18))).size).toBe(3)
  })
})
