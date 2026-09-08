// BUG-FROSTALERTNOAPP-001 — the pure half.
//
// EVERY ASSERTION HERE NAMES A VALUE ONLY A REAL COMPUTATION PRODUCES. That is deliberate and it is
// this file's own house rule: a sibling suite (CultivationLead) shipped three cases that gated on a
// spy call and then asserted a string the component holds before AND after its data arrives, so all
// three stayed green with the payload discarded. The equivalent mistake here would be asserting
// `toBeNull()` everywhere — null is what this builder returns for malformed input, empty input, no
// input, and correctly-excluded input alike, so a null assertion distinguishes none of them. Where a
// case expects null, it is paired with a NEAR-MISS that differs in exactly one field and returns a
// line, so the null is attributable to the thing under test rather than to nothing having happened.
import { describe, it, expect } from 'vitest'
import { buildFrostAlertLine, pickAdvisory, whenPhrase } from '../lib/frostAlertLine.js'

const advisory = (over = {}) => ({
  key: 'sp1|2026-09-07|advisory|advisory|abc',
  tier: 'advisory', level: 'advisory',
  at: '2026-09-07T23:27:07.892Z',
  lowF: 38, dayOffset: 1, date: '2026-09-08',
  ...over,
})

describe('whenPhrase — mirrors frostEval advisoryMessage exactly', () => {
  it('says "tomorrow night" at offset 1, not "in 1 days"', () => {
    expect(whenPhrase(1)).toBe('tomorrow night')
  })
  it('counts days beyond that', () => {
    expect(whenPhrase(2)).toBe('in 2 days')
    expect(whenPhrase(3)).toBe('in 3 days')
  })
  it('refuses offsets that cannot describe a future night', () => {
    // 0 would be tonight, which an advisory never is — evalAdvisory sets dayOffset = i + 1.
    expect(whenPhrase(0)).toBeNull()
    expect(whenPhrase(null)).toBeNull()
    expect(whenPhrase('soon')).toBeNull()
    // NEAR-MISS CONTROL: the only difference is a usable offset, and it words.
    expect(whenPhrase(1)).toBe('tomorrow night')
  })
})

describe('buildFrostAlertLine', () => {
  it('words a real advisory with both facts the SNS text carries', () => {
    const line = buildFrostAlertLine([advisory()])
    expect(line).not.toBeNull()
    expect(line.text).toBe('Frost possible tomorrow night — low 38°F. Plan cover for tender plants.')
    expect(line.lowF).toBe(38)
    expect(line.dayOffset).toBe(1)
  })

  it('states the distance when the cold night is further out', () => {
    const line = buildFrostAlertLine([advisory({ dayOffset: 3, lowF: 31 })])
    expect(line.text).toBe('Frost possible in 3 days — low 31°F. Plan cover for tender plants.')
  })

  it('rounds a fractional forecast low rather than printing it raw', () => {
    expect(buildFrostAlertLine([advisory({ lowF: 37.6 })]).text).toMatch(/low 38°F/)
  })

  // ── The exclusions. Each is paired with a control proving the null is attributable. ──────────────

  it('renders nothing for an IMMINENT alert — the freeze cue on Today already covers tonight', () => {
    const imminent = advisory({ tier: 'imminent', level: 'protect', dayOffset: 0 })
    expect(buildFrostAlertLine([imminent])).toBeNull()
    // CONTROL: same entry, advisory tier and a future night — a line appears. So the null above is
    // the tier exclusion firing, not a malformed fixture.
    expect(buildFrostAlertLine([{ ...imminent, tier: 'advisory', dayOffset: 1 }])).not.toBeNull()
  })

  it('renders nothing for a HEAT alert — computeCallout already renders high >= 88', () => {
    const heat = advisory({ tier: 'heat', level: 'heat' })
    expect(buildFrostAlertLine([heat])).toBeNull()
    expect(buildFrostAlertLine([{ ...heat, tier: 'advisory' }])).not.toBeNull()
  })

  it('renders nothing for a legacy entry with no temperature — 66 such rows existed in prod', () => {
    const legacy = { key: 'k', tier: 'advisory', level: 'advisory', at: '2026-09-07T23:27:07.892Z' }
    expect(buildFrostAlertLine([legacy])).toBeNull()
    // CONTROL: the SAME entry plus the two fields the handler now persists does render, which is
    // what proves this null is the missing-facts guard and not the tier or the shape.
    expect(buildFrostAlertLine([{ ...legacy, lowF: 39, dayOffset: 2 }]).text)
      .toBe('Frost possible in 2 days — low 39°F. Plan cover for tender plants.')
  })

  it('renders nothing on an empty array — the common case, and not a blank strip', () => {
    // Today's two prod rows on 2026-09-08 both carried alerts_sent: [].
    expect(buildFrostAlertLine([])).toBeNull()
    expect(buildFrostAlertLine(null)).toBeNull()
    expect(buildFrostAlertLine(undefined)).toBeNull()
    expect(buildFrostAlertLine('not an array')).toBeNull()
    expect(buildFrostAlertLine([null, undefined])).toBeNull()
    expect(buildFrostAlertLine([advisory()])).not.toBeNull()   // control
  })

  it('takes the most recently SENT advisory when a night produced more than one', () => {
    const older = advisory({ lowF: 39, dayOffset: 2, at: '2026-09-07T18:00:00.000Z' })
    const newer = advisory({ lowF: 33, dayOffset: 1, at: '2026-09-07T23:27:07.892Z' })
    // Array order deliberately opposite to send order — handler appends, but `at` is authoritative.
    expect(buildFrostAlertLine([newer, older]).lowF).toBe(33)
    expect(buildFrostAlertLine([older, newer]).lowF).toBe(33)
  })

  it('ignores unusable entries mixed in beside a good one', () => {
    const line = buildFrostAlertLine([
      null,
      { tier: 'heat', level: 'heat', lowF: 20, dayOffset: 1, at: 'z' },
      { tier: 'advisory', lowF: null, dayOffset: 1, at: 'z' },
      advisory({ lowF: 36, dayOffset: 2 }),
    ])
    expect(line.text).toBe('Frost possible in 2 days — low 36°F. Plan cover for tender plants.')
  })

  it('pickAdvisory returns the entry itself, so the component can key off tier/offset', () => {
    expect(pickAdvisory([advisory({ dayOffset: 2 })])).toMatchObject({ tier: 'advisory', dayOffset: 2 })
  })
})
