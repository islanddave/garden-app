/**
 * src/__tests__/frostBands.parity.test.js
 *
 * End of season screen (lane seasonend-20260929) — the page's copy of the frost alert's band map.
 *
 * WHY A COPY. lambda/daily-plan/frostClass.js owns BAND_BY_SLUG and the browser cannot import it (a
 * CommonJS Lambda module that reads process.env at load). scripts/gen-frost-bands.mjs writes
 * src/lib/frostBands.generated.js from it; this file is the drift guard, in the unit suite CI already
 * runs. Same house pattern as eventTypes.generated.js, pointed the other way.
 *
 * Every case names the mutation that turns it red; each was applied and observed red, then reverted.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import fc from '../../lambda/daily-plan/frostClass.js'
import { FROST_BAND_BY_SLUG, FROST_BANDS } from '../lib/frostBands.generated.js'
import { renderFrostBands } from '../../scripts/gen-frost-bands.mjs'

const GENERATED = resolve(process.cwd(), 'src/lib/frostBands.generated.js')

describe('frostBands.generated.js — parity with frostClass.BAND_BY_SLUG', () => {
  // KILLING MUTATION: change one band in the generated file (tomato: 'tender' -> 'hardy'), or band a
  // new slug in frostClass.js without regenerating. RESULT: RED.
  it('holds exactly the source map: same slugs, same bands', () => {
    expect({ ...FROST_BAND_BY_SLUG }).toEqual({ ...fc.BAND_BY_SLUG })
    expect(Object.keys(FROST_BAND_BY_SLUG).length).toBeGreaterThan(100)
    expect([...FROST_BANDS]).toEqual([...fc.BAND_ORDER])
  })

  // KILLING MUTATION: hand-edit anything in the generated file, a comment included. RESULT: RED —
  // the file must be what the generator writes, so "regenerate" is always a no-op diff or a real one.
  it('is byte-identical to what the generator writes now', () => {
    expect(readFileSync(GENERATED, 'utf8')).toBe(renderFrostBands(fc))
  })

  // KILLING MUTATION: generate from CLASS_BY_SLUG, or add an UNKNOWN_BAND fallback for the
  // deliberately unmapped slugs. RESULT: RED — sedum/rosemary/bay would read as banded.
  it('gives the deliberately unmapped slugs and the food classes NO band', () => {
    expect(fc.UNCERTAIN_SLUGS.length).toBeGreaterThan(0)
    for (const s of [...fc.UNCERTAIN_SLUGS, ...fc.NON_PLANT_FOOD_SLUGS]) {
      expect(Object.hasOwn(FROST_BAND_BY_SLUG, s), s).toBe(false)
    }
  })

  // KILLING MUTATION: build the copy through CLASS_BY_BAND (tropical/light_frost_tolerant -> 'tender').
  // RESULT: RED — the band is the one written in SLUGS_BY_BAND, not the alert's 3-class fold.
  it('keeps the five bands distinct — tropical and light-frost crops are not folded into tender', () => {
    expect(FROST_BAND_BY_SLUG.lemon_verbena).toBe('tropical')
    expect(FROST_BAND_BY_SLUG.petunia).toBe('light_frost_tolerant')
    expect(FROST_BAND_BY_SLUG.basil).toBe('chill_sensitive')
    expect(FROST_BAND_BY_SLUG.tomato).toBe('tender')
    expect(FROST_BAND_BY_SLUG.kale).toBe('hardy')
    for (const band of Object.values(FROST_BAND_BY_SLUG)) expect(FROST_BANDS).toContain(band)
  })

  it('is frozen, so no caller can band a slug at runtime', () => {
    expect(Object.isFrozen(FROST_BAND_BY_SLUG)).toBe(true)
    expect(Object.isFrozen(FROST_BANDS)).toBe(true)
  })
})
