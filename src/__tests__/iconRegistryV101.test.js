// V4-ICON-001 (DESIGNSYS Pass B V101) — static CI harness for the go-forward registry.
// Covers §14: registry schema validation, coverage completeness, accessibleName lint,
// path-property lint (round-only joins/caps, no raw hex). The optical-weight golden +
// region-seam checks are engine-dependent (resvg) and land in the next increment.
import { describe, it, expect } from 'vitest'
import { GLYPHS, getIcon, isSvg, NEUTRAL_ICON } from '../lib/iconRegistry.js'
import manifest from '../lib/icon-coverage-manifest.json'

const CLASSES = ['mono', 'color-candidate']
const REGISTERS = ['functional', 'illustrated']
const nameOk = (n) => (typeof n === 'string' && n.length > 0) ||
  (n && typeof n === 'object' && Object.values(n).every(v => typeof v === 'string' && v.length > 0))

describe('GLYPHS — registry schema validation (§13)', () => {
  for (const [key, e] of Object.entries(GLYPHS)) {
    it(`${key} has a valid V101 entry`, () => {
      expect(e.key).toBe(key)
      expect(CLASSES).toContain(e.class)
      expect(REGISTERS).toContain(e.register)
      expect(e.schemaVersion).toBe(101)
      expect(typeof e.variant).toBe('string')
      expect(typeof e.svg24).toBe('string')
      expect(typeof e.svg18).toBe('string')
      expect(isSvg(e)).toBe(true)
    })
  }
})

describe('GLYPHS — coverage completeness (§9 manifest)', () => {
  // Iterates EVERY array-valued property, not just anchorSet, so adding a family to
  // icon-coverage-manifest.json is all it takes to guard it. Until 2026-08-26 this looped over
  // anchorSet alone — 8 of 108 keys — so the one check that exists to catch "a §9 family was
  // specified but never drawn" could not see the four families that were in exactly that state.
  const families = Object.entries(manifest).filter(([, v]) => Array.isArray(v))
  for (const [family, keys] of families) {
    it(`registry ⊇ manifest family "${family}" (${keys.length} keys)`, () => {
      const missing = keys.filter((k) => !GLYPHS[k])
      expect(missing, `manifest family "${family}" names key(s) the registry does not carry`).toEqual([])
    })
  }
  it('the manifest is non-vacuous', () => {
    // Same vacuity floor as scripts/icon-ci/*.mjs: every assertion above is a loop over the
    // manifest, so emptying it (or renaming its arrays to objects) would be a clean pass over
    // nothing. 82 non-event keys guarded at the V4-ICON-001 draw; floor is slack for churn.
    const guarded = new Set(families.flatMap(([, keys]) => keys))
    expect(families.length).toBeGreaterThanOrEqual(2)
    expect(guarded.size).toBeGreaterThanOrEqual(60)
  })
})

describe('GLYPHS — accessibleName lint (§12.5)', () => {
  for (const [key, e] of Object.entries(GLYPHS)) {
    it(`${key} has a non-empty accessibleName`, () => expect(nameOk(e.accessibleName)).toBe(true))
  }
})

describe('GLYPHS — path-property lint (§14: round-only, no raw hex)', () => {
  const masters = (e) => [e.svg24, e.svg18, ...(e.variants ? Object.values(e.variants).flatMap(v => [v.svg24, v.svg18]) : [])].filter(Boolean)
  for (const [key, e] of Object.entries(GLYPHS)) {
    it(`${key} masters use no miter/butt/square and no raw hex`, () => {
      for (const m of masters(e)) {
        expect(/stroke-linejoin\s*=\s*"?(miter|bevel)/i.test(m)).toBe(false)
        expect(/stroke-linecap\s*=\s*"?(butt|square)/i.test(m)).toBe(false)
        expect(/#[0-9a-fA-F]{3,8}\b/.test(m)).toBe(false) // colors come from currentColor / the color pass, never baked
      }
    })
  }
})

describe('GLYPHS — color-candidate region-intent (§1 bridge)', () => {
  it('care.drop declares region intent + a multi-region filled variant', () => {
    const d = GLYPHS['care.drop']
    expect(d.class).toBe('color-candidate')
    expect(d.regionIntent && Object.keys(d.regionIntent).length).toBeGreaterThan(0)
    expect(d.variants.filled.svg24).toMatch(/data-region="body"/)
  })
})

describe('getIcon / NEUTRAL — never throws (§15)', () => {
  it('unknown key resolves to the neutral fallback, not undefined/throw', () => {
    expect(() => getIcon('zzz.nope')).not.toThrow()
    expect(getIcon('zzz.nope')).toBe(NEUTRAL_ICON)
    expect(isSvg(NEUTRAL_ICON)).toBe(true)
  })
  it('known key resolves to its entry', () => {
    expect(getIcon('nav.today').key).toBe('nav.today')
  })
})
