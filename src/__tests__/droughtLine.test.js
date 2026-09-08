// V5-DROUGHTSPACE-001 — the garden-wide drought line, read off the stored plan payload.
//
// The wording itself is asserted server-side (lambda/daily-plan/droughtsignal.test.js), because that is
// where it is written. What is tested HERE is the reader's refusals: the payload arrives from a Lambda
// that deploys on a different pipeline and can be older than this bundle, so every field it carries is
// untrusted input, not a contract.
import { describe, it, expect } from 'vitest'
import { buildDroughtLine } from '../lib/droughtLine.js'

// The exact shape droughtSignal.gardenDrought emits for the real 2026-08-04..2026-08-31 window.
const LIVE = {
  drought: {
    note: 'The garden has not had a deep soak in 28 days — no day at or above 0.60 in of rain, and no '
      + 'garden-wide deep watering. Check soil moisture at root depth.',
    dry_days: 28, deep_soak_in: 0.6, last_deep_soak: '2026-08-03', last_deep_water: null, truncated: false,
  },
}

describe('buildDroughtLine', () => {
  it('passes the server-written sentence through verbatim', () => {
    const line = buildDroughtLine(LIVE)
    expect(line.text).toBe(LIVE.drought.note)
    expect(line.dryDays).toBe(28)
    expect(line.truncated).toBe(false)
    expect(line.lastDeepSoak).toBe('2026-08-03')
    expect(line.lastDeepWater).toBe(null)
  })

  it('renders nothing when the key is absent — which is most days', () => {
    // The handler spreads `drought` CONDITIONALLY, so a quiet day has no key at all.
    expect(buildDroughtLine({ weather: {}, counts: {} })).toBe(null)
    expect(buildDroughtLine({})).toBe(null)
    expect(buildDroughtLine(null)).toBe(null)
    expect(buildDroughtLine(undefined)).toBe(null)
  })

  it('renders nothing for a malformed or empty payload rather than a blank strip', () => {
    expect(buildDroughtLine({ drought: null })).toBe(null)
    expect(buildDroughtLine({ drought: 'dry' })).toBe(null)
    expect(buildDroughtLine({ drought: [] })).toBe(null)
    expect(buildDroughtLine({ drought: { dry_days: 28 } })).toBe(null)          // no note
    expect(buildDroughtLine({ drought: { note: '   ', dry_days: 28 } })).toBe(null)
  })

  it('refuses a note with no usable day count — the sentence\'s whole content is the number', () => {
    expect(buildDroughtLine({ drought: { note: 'x', dry_days: null } })).toBe(null)
    expect(buildDroughtLine({ drought: { note: 'x', dry_days: 0 } })).toBe(null)
    expect(buildDroughtLine({ drought: { note: 'x', dry_days: 'lots' } })).toBe(null)
  })

  it('REFUSES a note that says "no rain in N days" — the category slip, even from the server', () => {
    // 0.60 in is the in-ground DEEP class, not rain-in-general. An older Lambda could still emit the
    // slipped wording; rendering it would state something false about his garden. Silence is recoverable.
    expect(buildDroughtLine({ drought: { note: 'No rain in 28 days.', dry_days: 28 } })).toBe(null)
    expect(buildDroughtLine({ drought: { note: 'No measurable rain in 28 days.', dry_days: 28 } })).toBe(null)
    // ...and the shipped wording is NOT caught by that guard — a filter that rejects everything is
    // indistinguishable from a feature that never renders.
    expect(buildDroughtLine(LIVE)).not.toBe(null)
  })

  it('carries `truncated` so an "at least N days" run is distinguishable downstream', () => {
    const t = buildDroughtLine({ drought: { ...LIVE.drought, truncated: true, dry_days: 30 } })
    expect(t.truncated).toBe(true)
    expect(t.dryDays).toBe(30)
  })

  it('reports the watering reset date when a watering is what ended the last run', () => {
    const w = buildDroughtLine({ drought: { ...LIVE.drought, last_deep_soak: null, last_deep_water: '2026-08-11' } })
    expect(w.lastDeepWater).toBe('2026-08-11')
    expect(w.lastDeepSoak).toBe(null)
  })
})
