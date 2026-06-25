// DESIGNSYS Pass A — token contract + parity tests (V4-DESIGNSYS-001).
// Pins that the parity-extraction kept EXACT values: promoted drift hexes, the new
// T ramps/badge tokens, the tokens.js re-export surface, getStatusColors parity vs
// the prior STATUS_COLORS literals, and iconRegistry status glyphs == the glyphs
// PlantStatusBadge previously rendered. A regression in any promoted value = a visual
// change, which Pass A forbids.
import { describe, it, expect } from 'vitest'
import { P } from '../lib/constants.js'
import { T } from '../components/forms/formStyles.js'
import { P as TP, T as TT, tokens, FACET_TOKENS } from '../lib/tokens.js'
import { getStatusColors } from '../lib/status.js'
import { ICONS, statusGlyph } from '../lib/iconRegistry.js'
import { statusIcon } from '../components/PlantStatusBadge.jsx'

describe('P — promoted drift literals (exact hexes)', () => {
  it('pins the four headline promoted hexes', () => {
    expect(P.statusInkGold).toBe('#7a5c00')
    expect(P.neutralFill).toBe('#eee')
    expect(P.bannerInk).toBe('#7a2a10')
    expect(P.severityStaleBorder).toBe('#d4b556')
  })
  it('pins the additional scoped-file promotions', () => {
    expect(P.preparingFill).toBe('#f0e9e0')
    expect(P.badgeInfoBg).toBe('#e8f0fa')
  })
  it('pins the 4 facet token triples (bg/text/border)', () => {
    expect([P.fTypeBg, P.fTypeText, P.fTypeBorder]).toEqual(['#e6f0e8', '#1f5138', '#bcd7c4'])
    expect([P.fGroupBg, P.fGroupText, P.fGroupBorder]).toEqual(['#eef0fa', '#3a3f6b', '#c9cdec'])
    expect([P.fLocationBg, P.fLocationText, P.fLocationBorder]).toEqual(['#f3ece2', '#6b4f2a', '#ddcdb6'])
    expect([P.fFreeformBg, P.fFreeformText, P.fFreeformBorder]).toEqual(['#f0efed', '#4a4a4a', '#d9d4cd'])
  })
})

describe('T — type / space / badge ramps (exact values)', () => {
  it('type ramp', () => {
    expect(T.type).toEqual({ xs: '0.72rem', sm: '0.82rem', base: '0.9rem', md: '0.95rem' })
  })
  it('space ramp', () => {
    expect(T.space).toEqual({ xs: 5, sm: 10, md: 16, lg: 20 })
  })
  it('badge tokens match prior PlantStatusBadge inline values', () => {
    expect(T.badgeFontSm).toBe('0.73rem')
    expect(T.badgeFontLg).toBe('0.85rem')
    expect(T.badgePadSm).toBe('2px 9px')
    expect(T.badgePadLg).toBe('4px 12px')
    expect(T.radiusBadge).toBe(12)
  })
})

describe('tokens.js — canonical re-export surface', () => {
  it('re-exports the SAME P and T object references', () => {
    expect(TP).toBe(P)
    expect(TT).toBe(T)
  })
  it('tokens groups color/space/type/radius', () => {
    expect(tokens.color).toBe(P)
    expect(tokens.space).toBe(T.space)
    expect(tokens.type).toBe(T.type)
    expect(tokens.radius).toEqual({ field: 7, button: 8, card: 10, badge: 12 })
  })
  it('FACET_TOKENS shapes each facet as {bg,text,border}', () => {
    expect(FACET_TOKENS.type).toEqual({ bg: '#e6f0e8', text: '#1f5138', border: '#bcd7c4' })
    expect(FACET_TOKENS.freeform).toEqual({ bg: '#f0efed', text: '#4a4a4a', border: '#d9d4cd' })
  })
})

describe('getStatusColors — parity vs prior STATUS_COLORS literals', () => {
  it('planning + harvesting ink stays the promoted gold', () => {
    expect(getStatusColors('planning').text).toBe('#7a5c00')
    expect(getStatusColors('harvesting').text).toBe('#7a5c00')
  })
  it('harvested / ended / dormant bg stays the neutral fill', () => {
    expect(getStatusColors('harvested').bg).toBe('#eee')
    expect(getStatusColors('ended').bg).toBe('#eee')
    expect(getStatusColors('dormant').bg).toBe('#eee')
  })
  it('preparing bg stays its exact hex', () => {
    expect(getStatusColors('preparing').bg).toBe('#f0e9e0')
  })
  it('unknown status still falls through to planning', () => {
    expect(getStatusColors('nope')).toEqual(getStatusColors('planning'))
  })
})

describe('iconRegistry — status glyphs == prior PlantStatusBadge glyphs', () => {
  const PRIOR = {
    seed: '🌰', rooting: '🫚', seedling: '🌱', sprouting: '🌱', seeding: '🌱',
    vegetative: '🌿', growing: '🌿', active: '🌿',
    flowering: '🌸', fruiting: '🍅', harvesting: '🧺', harvested: '✅',
    dormant: '💤', planning: '📋', ended: '⏹️', failed: '✕', dead: '✕',
  }
  it('every prior glyph is preserved verbatim', () => {
    for (const [k, glyph] of Object.entries(PRIOR)) {
      expect(ICONS.status[k].glyph).toBe(glyph)
      expect(statusGlyph(k)).toBe(glyph)
    }
  })
  it('statusGlyph + statusIcon fall back to the neutral dot, never throw', () => {
    expect(statusGlyph('zzz')).toBe('•')
    expect(statusIcon('zzz')).toBe('•')
    expect(statusIcon('seed')).toBe('🌰')
  })
})
