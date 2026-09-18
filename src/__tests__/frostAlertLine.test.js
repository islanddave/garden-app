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
//
// BUG-FROSTADVISORYNIGHTWORDING-001 — this file used to pin the night worded from `dayOffset` alone
// ("tomorrow night" at 1, "in N days" beyond, 0 refused). dayOffset is the CIVIL DAY of the minimum and
// that wording named most nights one late. The line now words `nightOffset`, the night the SNS text
// named; an entry without it takes the base rate (dayOffset - 1). The cross-check against the server's
// own wording is lambda/daily-plan/advisorynight.test.js (PARITY).
import { describe, it, expect } from 'vitest'
import { buildFrostAlertLine, pickAdvisory, resolveNight, nightPhrase } from '../lib/frostAlertLine.js'

// Handler-shaped: plan date 2026-09-07, D1 = 09-08, its minimum before dawn -> tonight (nightOffset 0).
const advisory = (over = {}) => ({
  key: 'sp1|2026-09-07|advisory|advisory|abc',
  tier: 'advisory', level: 'advisory',
  at: '2026-09-07T23:27:07.892Z',
  lowF: 38, dayOffset: 1, date: '2026-09-08', nightOffset: 0,
  ...over,
})

describe('nightPhrase — mirrors frostEval nightPhrase exactly', () => {
  it('says "tonight" at 0 and "tomorrow night" at 1', () => {
    expect(nightPhrase({ nightOffset: 0, nightDate: '2026-09-07' })).toBe('tonight')
    expect(nightPhrase({ nightOffset: 1, nightDate: '2026-09-08' })).toBe('tomorrow night')
  })
  it('names the weekday the night STARTS on from 2', () => {
    expect(nightPhrase({ nightOffset: 2, nightDate: '2026-09-09' })).toBe('Wednesday night')
    expect(nightPhrase({ nightOffset: 3, nightDate: '2026-09-10' })).toBe('Thursday night')
  })
  it('reads the weekday from the label, not the phone\'s zone', () => {
    // A local read of the UTC anchor is the previous day west of UTC (Saturday here, in New York).
    expect(nightPhrase({ nightOffset: 2, nightDate: '2026-11-01' })).toBe('Sunday night')
  })
  it('says how far rather than naming a wrong day when there is no date', () => {
    expect(nightPhrase({ nightOffset: 3, nightDate: null })).toBe('in 3 days')
  })
  it('refuses what cannot name a night', () => {
    expect(nightPhrase({ nightOffset: -1 })).toBeNull()
    expect(nightPhrase({ nightOffset: null })).toBeNull()
    expect(nightPhrase(null)).toBeNull()
    // NEAR-MISS CONTROL: the only difference is a usable offset, and it words.
    expect(nightPhrase({ nightOffset: 0 })).toBe('tonight')
  })
})

describe('resolveNight — the entry\'s own night, else the base rate', () => {
  it('uses nightOffset and derives the start date from the minimum\'s civil date', () => {
    expect(resolveNight(advisory())).toEqual({ nightOffset: 0, nightDate: '2026-09-07' })
    expect(resolveNight(advisory({ nightOffset: 1 }))).toEqual({ nightOffset: 1, nightDate: '2026-09-08' })
    expect(resolveNight(advisory({ dayOffset: 3, date: '2026-09-10', nightOffset: 2 })))
      .toEqual({ nightOffset: 2, nightDate: '2026-09-09' })
  })
  it('an entry written BEFORE nightOffset existed falls back to the night that ended on the minimum\'s morning', () => {
    const legacy = advisory()
    delete legacy.nightOffset
    expect(resolveNight(legacy)).toEqual({ nightOffset: 0, nightDate: '2026-09-07' })
    expect(resolveNight({ ...legacy, dayOffset: 3, date: '2026-09-10' })).toEqual({ nightOffset: 2, nightDate: '2026-09-09' })
  })
  it('a null nightOffset is ABSENT, never tonight (Number(null) is 0)', () => {
    expect(resolveNight(advisory({ nightOffset: null, dayOffset: 2, date: '2026-09-09' })))
      .toEqual({ nightOffset: 1, nightDate: '2026-09-08' })
  })
  it('nothing to resolve from', () => {
    expect(resolveNight({ tier: 'advisory' })).toBeNull()
    expect(resolveNight({ dayOffset: 0 })).toBeNull()
    expect(resolveNight(null)).toBeNull()
    expect(resolveNight({ dayOffset: 1 })).toEqual({ nightOffset: 0, nightDate: null })   // control
  })
})

describe('buildFrostAlertLine', () => {
  it('words a real advisory with both facts the SNS text carries', () => {
    const line = buildFrostAlertLine([advisory()])
    expect(line).not.toBeNull()
    expect(line.text).toBe('Frost possible tonight — low 38°F. Plan cover for tender plants.')
    expect(line.lowF).toBe(38)
    expect(line.dayOffset).toBe(1)
    expect(line.nightOffset).toBe(0)
  })

  it('a D1 minimum that falls late in the day is tomorrow night — the night, not the day, is worded', () => {
    expect(buildFrostAlertLine([advisory({ nightOffset: 1 })]).text)
      .toBe('Frost possible tomorrow night — low 38°F. Plan cover for tender plants.')
  })

  it('names the weekday when the cold night is further out', () => {
    const line = buildFrostAlertLine([advisory({ dayOffset: 3, date: '2026-09-10', nightOffset: 3, lowF: 31 })])
    expect(line.text).toBe('Frost possible Thursday night — low 31°F. Plan cover for tender plants.')
  })

  it('an entry stored before nightOffset existed still renders, on the base-rate night', () => {
    const legacy = advisory({ dayOffset: 3, date: '2026-09-10', lowF: 31 })
    delete legacy.nightOffset
    expect(buildFrostAlertLine([legacy]).text).toBe('Frost possible Wednesday night — low 31°F. Plan cover for tender plants.')
  })

  it('rounds a fractional forecast low rather than printing it raw', () => {
    expect(buildFrostAlertLine([advisory({ lowF: 37.6 })]).text).toMatch(/low 38°F/)
  })

  // ── The exclusions. Each is paired with a control proving the null is attributable. ──────────────

  it('renders nothing for an IMMINENT alert — the freeze cue on Today already covers tonight', () => {
    const imminent = advisory({ tier: 'imminent', level: 'protect', dayOffset: 0 })
    expect(buildFrostAlertLine([imminent])).toBeNull()
    // CONTROL: same entry, advisory tier and a real day offset — a line appears. So the null above is
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
    // CONTROL: the SAME entry plus the two fields the handler persisted first does render (on the
    // base-rate night, since it carries no nightOffset), which is what proves this null is the
    // missing-facts guard and not the tier or the shape.
    expect(buildFrostAlertLine([{ ...legacy, lowF: 39, dayOffset: 2 }]).text)
      .toBe('Frost possible tomorrow night — low 39°F. Plan cover for tender plants.')
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
    const older = advisory({ lowF: 39, dayOffset: 2, date: '2026-09-09', nightOffset: 1, at: '2026-09-07T18:00:00.000Z' })
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
      advisory({ lowF: 36, dayOffset: 2, date: '2026-09-09', nightOffset: 1 }),
    ])
    expect(line.text).toBe('Frost possible tomorrow night — low 36°F. Plan cover for tender plants.')
  })

  it('pickAdvisory returns the entry itself, so the component can key off tier/offset', () => {
    expect(pickAdvisory([advisory({ dayOffset: 2, date: '2026-09-09', nightOffset: 1 })]))
      .toMatchObject({ tier: 'advisory', dayOffset: 2, nightOffset: 1 })
  })
})
