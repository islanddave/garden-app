// V4-ICON-001 (Pass B V101) — event-glyph completeness + schema harness.
// Every canonical EVENT_TYPES value must resolve to an event.<type> glyph in GLYPHS
// (mono/functional/SVG, schemaVersion 101). Guards the surface-wire contract: a consumer
// rendering <Icon name={`event.${type}`}> never falls through to the neutral fallback.
import { describe, it, expect } from 'vitest'
import { GLYPHS, getIcon, isSvg, NEUTRAL_ICON } from '../lib/iconRegistry.js'
import { EVENT_GLYPHS } from '../lib/iconEvents.js'
import { EVENT_TYPES } from '../lib/eventTypes.js'

describe('event glyphs — completeness vs EVENT_TYPES (§9)', () => {
  it('every EVENT_TYPES value has an event.<type> glyph (no neutral fallthrough)', () => {
    for (const t of EVENT_TYPES) {
      const e = getIcon(`event.${t}`)
      expect(e, `missing event.${t}`).not.toBe(NEUTRAL_ICON)
      expect(e.key).toBe(`event.${t}`)
      expect(isSvg(e)).toBe(true)
    }
  })
  it('EVENT_GLYPHS count equals EVENT_TYPES count', () => {
    expect(Object.keys(EVENT_GLYPHS).length).toBe(EVENT_TYPES.length)
  })
})

describe('event glyphs — V101 entry shape', () => {
  for (const t of EVENT_TYPES) {
    it(`event.${t} is mono/functional/v101 with a non-empty accessibleName`, () => {
      const e = GLYPHS[`event.${t}`]
      expect(e.class).toBe('mono')
      expect(e.register).toBe('functional')
      expect(e.schemaVersion).toBe(101)
      expect(typeof e.accessibleName === 'string' && e.accessibleName.length).toBeTruthy()
    })
  }
})
