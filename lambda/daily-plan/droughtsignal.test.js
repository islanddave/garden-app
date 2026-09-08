// V5-LEGACYEXCEPTIONCARE-001 — the drought signal: 20 consecutive days with no >=0.60 in deep soak.
//
// THIS SUITE IS DELIBERATELY TWO-SIDED. The previous lane refused to build this trigger precisely
// because at the depth the crucible verdict named (0.10 in, the in-ground `light` class) NO fixture
// could fire at all — a one-sided suite would have passed against a dead branch. Dave settled the pair
// at (0.60 in, 20 d) on 2026-09-08, which fires twice in the live 121-day archive, so both directions
// are now testable and both are tested: it fires, it declines at 19, it RESETS on an intervening soak,
// and it REFUSES on a series too short to support the claim.
//
// The firing fixture is not invented. REAL_AUG_2026 is the verbatim live weather_daily precip series
// for 2026-08-02..2026-09-02 (prod Neon, read-only as garden_ro, 2026-09-08), including the 2.22 in day
// that opens the run and the 1.12 in day that closes it. Its interior is the 2026-08-04..2026-08-31
// stretch that took 0.81 in across 28 days with no single day at or above 0.60.
//
// MUTATION-PROVEN 2026-09-08 (each mutation applied alone, then reverted):
//   droughtSignal.js `byDate.get(day) >= deepSoakIn`  -> `>`   redded "exactly 0.60 in resets the counter"
//   droughtSignal.js `dryDays >= dryDaysRequired`     -> `>`   redded "fires at exactly 20 dry days"
//   droughtSignal.js reset branch (never break on a soak) ->   redded "an intervening deep soak resets"
//   droughtSignal.js coverage refusal (return ok not insufficient) -> redded the short-series guard
import { describe, it, expect, vi, afterEach } from 'vitest'
import handler from './handler.js'
import dr from './droughtSignal.js'
import LP from './ledgerParams.js'
import engine from './engine.js'
import cad from './cadence-data-v2.json'
import fm from './fertilization-model.json'
import _cf from './_coverFlags.js'

const { evaluateDrought, droughtNote, DEEP_SOAK_IN, DRY_DAYS, WINDOW_DAYS,
  deepWaterResetDays, gardenDroughtNote, gardenDrought, DEEP_WATER_SPACE_FRACTION } = dr
const { withCoverFlags } = _cf
const { generatePlan } = engine

const DAY = 86400000
const shift = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * DAY).toISOString().slice(0, 10)
// n days ending at `end`, each carrying `precip` (a number, or a fn(index-from-oldest) -> number).
const series = (end, n, precip) => Array.from({ length: n }, (_, i) => ({
  date: shift(end, -(n - 1 - i)),
  precip_in: typeof precip === 'function' ? precip(i) : precip,
}))

// Verbatim prod weather_daily, space Conway MA, 2026-08-02..2026-09-02.
const REAL_AUG_2026 = [
  ['2026-08-02', 0.00], ['2026-08-03', 2.22], ['2026-08-04', 0.00], ['2026-08-05', 0.00],
  ['2026-08-06', 0.02], ['2026-08-07', 0.00], ['2026-08-08', 0.09], ['2026-08-09', 0.00],
  ['2026-08-10', 0.00], ['2026-08-11', 0.00], ['2026-08-12', 0.00], ['2026-08-13', 0.01],
  ['2026-08-14', 0.00], ['2026-08-15', 0.00], ['2026-08-16', 0.00], ['2026-08-17', 0.21],
  ['2026-08-18', 0.01], ['2026-08-19', 0.00], ['2026-08-20', 0.09], ['2026-08-21', 0.00],
  ['2026-08-22', 0.04], ['2026-08-23', 0.34], ['2026-08-24', 0.00], ['2026-08-25', 0.00],
  ['2026-08-26', 0.00], ['2026-08-27', 0.00], ['2026-08-28', 0.00], ['2026-08-29', 0.00],
  ['2026-08-30', 0.00], ['2026-08-31', 0.00], ['2026-09-01', 1.12], ['2026-09-02', 1.12],
].map(([date, precip_in]) => ({ date, precip_in }))

// Verbatim prod weather_daily, 2026-08-25..2026-09-07. Its point is 2026-09-06: 0.29 in, GAUGE-sourced,
// which cleared rainLog's 0.10 in bar and auto-logged 218 rain EVENTS — and which must still count as a
// dry day here, because 0.29 < 0.60. This is the no-double-counting fixture.
const REAL_SEP_2026 = [
  ['2026-08-25', 0.00], ['2026-08-26', 0.00], ['2026-08-27', 0.00], ['2026-08-28', 0.00],
  ['2026-08-29', 0.00], ['2026-08-30', 0.00], ['2026-08-31', 0.00], ['2026-09-01', 1.12],
  ['2026-09-02', 1.12], ['2026-09-03', 0.04], ['2026-09-04', 0.04], ['2026-09-05', 0.01],
  ['2026-09-06', 0.29], ['2026-09-07', 0.00],
].map(([date, precip_in]) => ({ date, precip_in }))

// The live plan population on 2026-09-08 (garden_node, the handler's own predicate): 216 plantings.
const POP_216 = new Set(Array.from({ length: 216 }, (_, i) => `p${i}`))
// n distinct plantings deep-watered on `date`, drawn from POP_216.
const waterRows = (date, n, prefix = 'p') => Array.from({ length: n }, (_, i) => ({ date, plant_id: `${prefix}${i}` }))

describe('the settled parameters (canaries — a retune must reach Dave, not slip through)', () => {
  it('the depth IS the app\'s own in-ground `deep` class, and it is 0.60 in', () => {
    expect(DEEP_SOAK_IN).toBe(LP.RAIN_DEPTH_TIERS.in_ground.deep)
    expect(DEEP_SOAK_IN).toBe(0.60)
    // Not `light` (0.10). The whole correction to crucible Verdict 3 is that these are different numbers.
    expect(DEEP_SOAK_IN).not.toBe(LP.RAIN_DEPTH_TIERS.in_ground.light)
  })
  it('the day count is 20, and the read window is wide enough to make the claim', () => {
    expect(DRY_DAYS).toBe(20)
    expect(WINDOW_DAYS).toBeGreaterThanOrEqual(DRY_DAYS)
  })
})

describe('FIRES — the real 2026-08-04..2026-08-31 window', () => {
  it('fires on the live archive stretch: 28 days, 0.81 in total, no single day >= 0.60', () => {
    const interior = REAL_AUG_2026.filter((r) => r.date >= '2026-08-04' && r.date <= '2026-08-31')
    expect(interior).toHaveLength(28)
    expect(interior.every((r) => r.precip_in < 0.60)).toBe(true)
    expect(interior.reduce((a, r) => a + r.precip_in, 0)).toBeCloseTo(0.81, 5)

    const st = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31' })
    expect(st.status).toBe('dry')
    expect(st.dryDays).toBe(28)
    expect(st.lastDeepSoakDate).toBe('2026-08-03')   // the 2.22 in day that opened the run
    expect(st.truncated).toBe(false)
  })
  it('fires at exactly 20 dry days — the boundary, not a comfortable margin', () => {
    const rows = [{ date: '2026-08-11', precip_in: 0.75 }, ...series('2026-08-31', 20, 0.0)]
    const st = evaluateDrought(rows, { asOfDate: '2026-08-31' })
    expect(st.status).toBe('dry')
    expect(st.dryDays).toBe(20)
    expect(st.lastDeepSoakDate).toBe('2026-08-11')
  })
  it('exactly 0.60 in resets the counter (>=, matching ledger.rainDepthClass); 0.59 does not', () => {
    // index 10 of 30 == 2026-08-12, leaving 19 dry days behind it. At 0.60 that is a reset and the
    // trigger stays quiet; at 0.59 nothing resets and the run walks the whole window.
    const at = evaluateDrought(series('2026-08-31', 30, (i) => (i === 10 ? 0.60 : 0.0)), { asOfDate: '2026-08-31' })
    expect(at.status).toBe('ok')
    expect(at.dryDays).toBe(19)
    expect(at.lastDeepSoakDate).toBe('2026-08-12')

    const under = evaluateDrought(series('2026-08-31', 30, (i) => (i === 10 ? 0.59 : 0.0)), { asOfDate: '2026-08-31' })
    expect(under.status).toBe('dry')
    expect(under.dryDays).toBe(30)
    expect(under.lastDeepSoakDate).toBe(null)
  })
})

describe('DOES NOT FIRE', () => {
  it('19 consecutive dry days does not fire — one short of the ruling', () => {
    const rows = [{ date: '2026-08-12', precip_in: 0.75 }, ...series('2026-08-31', 19, 0.0)]
    const st = evaluateDrought(rows, { asOfDate: '2026-08-31' })
    expect(st.status).toBe('ok')
    expect(st.dryDays).toBe(19)
    expect(droughtNote(st)).toBe(null)
  })
  it('an intervening deep soak resets: 25 days with one 0.80 in day in the middle', () => {
    // 25 days ending 2026-08-31; day index 12 (2026-08-19) takes 0.80 in. That leaves 12 dry days
    // after it. A day-counter that ignores the reset would call this 25 and fire; a drought trigger
    // must call it 12 and stay quiet.
    const rows = series('2026-08-31', 25, (i) => (i === 12 ? 0.80 : 0.0))
    const st = evaluateDrought(rows, { asOfDate: '2026-08-31' })
    expect(st.status).toBe('ok')
    expect(st.dryDays).toBe(12)
    expect(st.lastDeepSoakDate).toBe('2026-08-19')
    expect(droughtNote(st)).toBe(null)
  })
})

describe('SHORT-ARRAY GUARD — refuse, never report a false negative', () => {
  it('14 dry days refuses rather than reporting "no deep soak in 14 days"', () => {
    const st = evaluateDrought(series('2026-08-31', 14, 0.0), { asOfDate: '2026-08-31' })
    expect(st.status).toBe('insufficient')     // NOT 'ok' — 'ok' would assert a fact we cannot support
    expect(st.gap).toBe('short_series')
    expect(st.covered).toBe(14)
    expect(st.needed).toBe(20)
    expect(droughtNote(st)).toBe(null)
  })
  it('an empty series, a null series, and a missing asOfDate all refuse', () => {
    expect(evaluateDrought([], { asOfDate: '2026-08-31' }).status).toBe('insufficient')
    expect(evaluateDrought(null, { asOfDate: '2026-08-31' }).status).toBe('insufficient')
    expect(evaluateDrought(null, { asOfDate: '2026-08-31' }).gap).toBe('series_unavailable')
    expect(evaluateDrought(series('2026-08-31', 30, 0.0), {}).status).toBe('insufficient')
  })
  it('a HOLE inside the window refuses — a missing day is absent, never dry', () => {
    // 30 dry days with 2026-08-20 removed. That day could have carried two inches; the counter that
    // walks past it is claiming 30 observed days when it has seen 11.
    const rows = series('2026-08-31', 30, 0.0).filter((r) => r.date !== '2026-08-20')
    const st = evaluateDrought(rows, { asOfDate: '2026-08-31' })
    expect(st.status).toBe('insufficient')
    expect(st.covered).toBe(11)                // 2026-08-21..2026-08-31
  })
  it('a null precip_in is a hole, not a dry day', () => {
    const rows = series('2026-08-31', 30, (i) => (i === 22 ? null : 0.0))
    expect(evaluateDrought(rows, { asOfDate: '2026-08-31' }).status).toBe('insufficient')
  })
  it('a hole PAST 20 confirmed dry days still fires — those 20 days were observed', () => {
    const rows = series('2026-08-31', 30, 0.0).filter((r) => r.date !== '2026-08-05')
    const st = evaluateDrought(rows, { asOfDate: '2026-08-31' })
    expect(st.status).toBe('dry')
    expect(st.dryDays).toBe(26)                // 2026-08-06..2026-08-31
    expect(st.truncated).toBe(true)
  })
})

// ── V5-DROUGHTSPACE-001 — the counter must honour LOGGED EVENTS, not just weather data ───────────
// Dave, 2026-09-08: "ensure it is not just about watering events but also rain events auto logged."
//
// The investigation split the two sources apart and they did NOT get the same answer. Auto-logged rain
// events are weather_daily.precip_in under another primary key (17 rain-event days in the record, ZERO
// without a matching weather_daily row, ZERO whose quantity differs from it), so adding them as a
// second source is double-counting by definition and is REFUSED. Watering events are a genuinely
// independent observation and are accepted — at Space scope, by the app's own 'deep' depth class, and
// never by a fabricated inches equivalence (quantity_numeric is NULL on all 10,229 of them).
describe('WATERING RESETS — the failure Dave named: telling him the garden is dry on a day he watered it', () => {
  it('FIRES on the real 28-day window when nothing qualifying was logged', () => {
    const st = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31', waterResetDays: new Set() })
    expect(st.status).toBe('dry')
    expect(st.dryDays).toBe(28)
    expect(st.resetBy).toBe('rain')                 // bounded below by the 2.22 in day of 2026-08-03
    expect(st.lastDeepWaterDate).toBe(null)
  })
  it('DOES NOT FIRE on the same window once the real 2026-08-24 deep watering is honoured', () => {
    // The live case, and the whole reason for this change. On ET 2026-08-24 Dave deep-watered 113 of
    // 216 plantings (186 of 216 got water that evening). The shipped counter said "no deep soak in 28
    // days" on 2026-08-31 anyway, because it read only weather_daily.
    const st = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31', waterResetDays: new Set(['2026-08-24']) })
    expect(st.status).toBe('ok')
    expect(st.dryDays).toBe(7)                      // 2026-08-25..2026-08-31
    expect(st.lastDeepWaterDate).toBe('2026-08-24')
    expect(st.resetBy).toBe('watering')
    expect(st.lastDeepSoakDate).toBe(null)          // it did NOT rain; the note must not claim it did
    expect(droughtNote(st)).toBe(null)
    expect(gardenDroughtNote(st)).toBe(null)
  })
  it('a watering reset wins over a HOLE in weather_daily — a logged soak needs no weather row', () => {
    // The counter refuses when the archive has a gap, because a missing day could have carried 2 in.
    // A day Dave logged a garden-wide deep watering on is not that kind of unknown: he told us.
    const rows = series('2026-08-31', 30, 0.0).filter((r) => r.date !== '2026-08-24')
    const blind = evaluateDrought(rows, { asOfDate: '2026-08-31' })
    expect(blind.status).toBe('insufficient')       // the shipped behaviour, unchanged
    const seen = evaluateDrought(rows, { asOfDate: '2026-08-31', waterResetDays: new Set(['2026-08-24']) })
    expect(seen.status).toBe('ok')
    expect(seen.dryDays).toBe(7)
    expect(seen.resetBy).toBe('watering')
  })
  it('a watering OUTSIDE the run does not shorten it — only the most recent reset counts', () => {
    // 2026-07-30 is behind the 2026-08-03 rain that already bounds this run, so it is invisible.
    const st = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31', waterResetDays: new Set(['2026-07-30']) })
    expect(st.status).toBe('dry')
    expect(st.dryDays).toBe(28)
    expect(st.resetBy).toBe('rain')
    expect(st.lastDeepWaterDate).toBe(null)
  })
  it('omitting waterResetDays entirely is byte-identical to the pre-change behaviour', () => {
    const a = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31' })
    const b = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31', waterResetDays: new Set() })
    expect(a).toEqual(b)
    expect(a.status).toBe('dry')
  })
  it('a FAILED watering read refuses — "he did not water" is not the same answer as "we could not tell"', () => {
    const st = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31', waterEventsUnavailable: true })
    expect(st.status).toBe('insufficient')
    expect(st.gap).toBe('water_events_unavailable')
    expect(gardenDroughtNote(st)).toBe(null)
  })
})

describe('NO DOUBLE-COUNTING — an auto-logged rain event is weather_daily under another name', () => {
  it('2026-09-06 auto-logged 218 rain events at 0.29 in and is STILL a dry day', () => {
    // The bar is the measured depth, not the existence of a rain event. rainLog logs anything above
    // 0.10 in; the deep-soak class is 0.60. Counting the event as a reset would reset on a fifth of a
    // deep soak — and counting it ALONGSIDE its own weather_daily row would count one rainfall twice.
    const st = evaluateDrought(REAL_SEP_2026, { asOfDate: '2026-09-07', waterResetDays: new Set() })
    expect(st.status).toBe('ok')
    expect(st.dryDays).toBe(5)                      // 2026-09-03..2026-09-07
    expect(st.lastDeepSoakDate).toBe('2026-09-02')  // the 1.12 in day, NOT the 0.29 in event day
    expect(st.resetBy).toBe('rain')
  })
  it('the rainfall that DID reset is counted once: the 1.12 in day is one reset, not two', () => {
    // 2026-09-01 and 2026-09-02 each measured 1.12 in and each auto-logged 217 rain events. The walk
    // stops at the FIRST reset going backwards, so the run length is a function of dates, never of how
    // many event rows a day produced. A source that summed events would double this day's contribution.
    const st = evaluateDrought(REAL_SEP_2026, { asOfDate: '2026-09-07' })
    expect(st.dryDays).toBe(5)
    expect(st.lastDeepSoakDate).toBe('2026-09-02')
  })
  it('the reset bar is the ledger deep class (0.60), which is 6x rainLog\'s event threshold (0.10)', () => {
    // A canary on the relationship, not on either number alone. If a retune ever brought them together,
    // "a rain event happened" and "a deep soak happened" would become the same claim and the refusal
    // above would silently stop meaning anything.
    expect(DEEP_SOAK_IN).toBeGreaterThan(0.10)
    expect(evaluateDrought(series('2026-08-31', 30, (i) => (i === 10 ? 0.29 : 0.0)),
      { asOfDate: '2026-08-31' }).status).toBe('dry')
  })
})

describe('THE AGGREGATION RULE — a garden-wide claim needs garden-wide evidence', () => {
  it('the fraction is a third, and it is a named judgement, not a derived quantity', () => {
    expect(DEEP_WATER_SPACE_FRACTION).toBeCloseTo(1 / 3, 10)
  })
  it('the four real deep-watering days split exactly as measured on prod', () => {
    // ET 2026-08-24 113/216 (52.3%) — a session. The other three are spot-watering: 20 (9.3%),
    // 10 (4.6%), 5 (2.3%). Bar = ceil(216/3) = 72.
    const out = deepWaterResetDays([
      ...waterRows('2026-08-24', 113), ...waterRows('2026-08-28', 20),
      ...waterRows('2026-08-31', 10), ...waterRows('2026-09-03', 5),
    ], POP_216)
    expect(out.population).toBe(216)
    expect(out.required).toBe(72)
    expect([...out.days]).toEqual(['2026-08-24'])
    expect(out.coverage).toEqual({ '2026-08-24': 113, '2026-08-28': 20, '2026-08-31': 10, '2026-09-03': 5 })
  })
  it('watering two plants in a 216-plant garden is not a garden-wide soak', () => {
    // Dave's own framing, as a test.
    expect([...deepWaterResetDays(waterRows('2026-08-24', 2), POP_216).days]).toEqual([])
  })
  it('the bar is a boundary: 72 of 216 qualifies, 71 does not', () => {
    expect(deepWaterResetDays(waterRows('2026-08-24', 72), POP_216).days.has('2026-08-24')).toBe(true)
    expect(deepWaterResetDays(waterRows('2026-08-24', 71), POP_216).days.has('2026-08-24')).toBe(false)
  })
  it('coverage is per DAY, never accumulated across the window', () => {
    // Forty plantings on each of two days is two spot-waters, not one session. A rule that summed the
    // window would reset on 80 and claim the garden was soaked on a day it was not.
    const out = deepWaterResetDays([...waterRows('2026-08-24', 40), ...waterRows('2026-08-25', 40, 'q')], POP_216)
    expect([...out.days]).toEqual([])
  })
  it('the same planting logged twice in a day counts ONCE', () => {
    // Multi-row same-day water is normal here — 25% of plant-day water buckets hold multiple rows
    // (lambda/plants/merge.js). Counting rows instead of plantings would let 72 logs on one plant pass.
    const dupes = Array.from({ length: 200 }, () => ({ date: '2026-08-24', plant_id: 'p0' }))
    expect([...deepWaterResetDays(dupes, POP_216).days]).toEqual([])
  })
  it('a planting outside this Space cannot reset this Space\'s line', () => {
    // Scope AND denominator come from the same set, so a neighbouring garden's session is invisible here.
    const foreign = Array.from({ length: 200 }, (_, i) => ({ date: '2026-08-24', plant_id: `other${i}` }))
    const out = deepWaterResetDays(foreign, POP_216)
    expect([...out.days]).toEqual([])
    expect(out.coverage).toEqual({})
  })
  it('a failed read is unavailable, an empty read is not', () => {
    expect(deepWaterResetDays(null, POP_216).unavailable).toBe(true)
    expect(deepWaterResetDays([], POP_216).unavailable).toBe(false)
    expect([...deepWaterResetDays([], POP_216).days]).toEqual([])
  })
  it('a Space with no plantings makes no claim and takes no reset', () => {
    const out = deepWaterResetDays(waterRows('2026-08-24', 5), new Set())
    expect(out.population).toBe(0)
    expect(out.unavailable).toBe(false)
    expect([...out.days]).toEqual([])
  })
  it('malformed rows are dropped, not coerced', () => {
    const out = deepWaterResetDays([
      null, { date: 'nope', plant_id: 'p1' }, { date: '2026-08-24', plant_id: null }, { plant_id: 'p2' },
      ...waterRows('2026-08-24', 72),
    ], POP_216)
    expect(out.coverage['2026-08-24']).toBe(72)
    expect(out.days.has('2026-08-24')).toBe(true)
  })
})

describe('WORDING — Dave\'s ruling: "no deep soak", never "no rain"', () => {
  const st = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31' })
  it('names the deep soak and its depth', () => {
    expect(droughtNote(st)).toMatch(/deep soak/i)
    expect(droughtNote(st)).toMatch(/0\.60 in/)
    expect(droughtNote(st)).toMatch(/28 days/)
  })
  it('never says "no rain in N days" — that is the category slip this trigger exists to avoid', () => {
    expect(droughtNote(st)).not.toMatch(/no rain in/i)
    expect(droughtNote(st)).not.toMatch(/no measurable rain/i)
  })
  it('says "at least" when the run was cut off by the window rather than by a soak', () => {
    const trunc = evaluateDrought(series('2026-08-31', 30, 0.0), { asOfDate: '2026-08-31' })
    expect(trunc.truncated).toBe(true)
    expect(droughtNote(trunc)).toMatch(/at least 30 days/)
  })
})

describe('THE GARDEN-WIDE LINE — one line, once, for the whole Space', () => {
  const DRY = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31' })
  it('says the GARDEN has not had a deep soak, and says how long', () => {
    const note = gardenDroughtNote(DRY)
    expect(note).toMatch(/garden/i)
    expect(note).toMatch(/deep soak/i)
    expect(note).toMatch(/28 days/)
    expect(note).toMatch(/0\.60 in/)
  })
  it('never says "no rain in N days" — the same category slip guard as the per-plant note', () => {
    expect(gardenDroughtNote(DRY)).not.toMatch(/no rain in/i)
    expect(gardenDroughtNote(DRY)).not.toMatch(/no measurable rain/i)
  })
  it('names the watering half, so the day count is explicable when it is a watering that reset it', () => {
    expect(gardenDroughtNote(DRY)).toMatch(/deep watering/i)
  })
  it('is silent on every state that is not `dry`', () => {
    expect(gardenDroughtNote(null)).toBe(null)
    expect(gardenDroughtNote(evaluateDrought(REAL_SEP_2026, { asOfDate: '2026-09-07' }))).toBe(null)
    expect(gardenDroughtNote(evaluateDrought(series('2026-08-31', 14, 0.0), { asOfDate: '2026-08-31' }))).toBe(null)
  })
  it('gardenDrought() is the payload key, and is null (absent, not empty) when quiet', () => {
    expect(gardenDrought(DRY)).toEqual({
      note: expect.stringMatching(/garden/i), dry_days: 28, deep_soak_in: 0.60,
      last_deep_soak: '2026-08-03', last_deep_water: null, truncated: false,
    })
    expect(gardenDrought(null)).toBe(null)
    expect(gardenDrought(evaluateDrought(REAL_SEP_2026, { asOfDate: '2026-09-07' }))).toBe(null)
  })
  it('carries the watering date when a watering is what reset it', () => {
    const st = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31', waterResetDays: new Set(['2026-08-11']) })
    expect(st.status).toBe('dry')                  // 2026-08-12..2026-08-31 is 20 days: still fires
    expect(st.dryDays).toBe(20)
    expect(gardenDrought(st).last_deep_water).toBe('2026-08-11')
    expect(gardenDrought(st).last_deep_soak).toBe(null)
  })
})

// ── Delivery surface: the dormancy_suppressed hook (6 of 219 live plantings) ──────────────────────
const NO_CAL_WATER = {
  _seeded: true, crop: 'blueberry', no_calendar_water: true, water_method: 'soak_then_dry',
  drought_tolerance: 'medium', water_interval_days_inground: 7, fertilize_interval_days: 0,
  soil_moisture_target: 'evenly moist; water on plant signal',
}
const P = (o) => withCoverFlags({
  assignee_user_id: 'dave', project: 'Beds', project_id: 'pb', project_status: 'active',
  variety: null, genus: null, container_type: 'in_ground', container_size: null,
  substrate_start: '2026-01-01', transplant_at: null, last_fert: null, covered: false, ...o,
})
const BLUEBERRY = P({ id: 'bb1', name: 'Blueberry', status: 'harvested', last_water: '2026-07-20', db_cadence: NO_CAL_WATER })
const planWith = (droughtState) => generatePlan({
  plantings: [BLUEBERRY], cadence: cad, fertModel: fm, today: '2026-09-01',
  weather: { tonightLow: 60, highToday: 80, unit: 'F' },
  hydrology: { recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0, tomorrow_precip_in: 0, tomorrow_pop: 0 },
  ownerFallback: 'dave', droughtState,
}).users.dave

describe('dormancy_suppressed delivery', () => {
  const DRY = evaluateDrought(REAL_AUG_2026, { asOfDate: '2026-08-31' })
  it('a suppressed planting carries the drought note and the structured key when the signal fires', () => {
    const row = planWith(DRY).tasks.dormancy_suppressed.find((x) => x.id === 'bb1')
    expect(row).toBeTruthy()
    expect(row.rule).toBe('no_calendar_water')
    expect(row.reason).toMatch(/deep soak/i)
    expect(row.reason).toMatch(/28 days/)
    expect(row.drought).toEqual({ dry_days: 28, deep_soak_in: 0.60, last_deep_soak: '2026-08-03', truncated: false })
  })
  it('the shipped suppression policy is UNCHANGED — the signal never routes it to water_due', () => {
    const u = planWith(DRY)
    expect(u.tasks.water_due.some((x) => x.id === 'bb1')).toBe(false)
    expect(u.tasks.no_history.some((x) => x.id === 'bb1')).toBe(false)
    expect(u.counts.dormancy_suppressed).toBe(1)
    expect(u.tasks.dormancy_suppressed[0].reason).toMatch(/never by interval/)
  })
  it('INERT when the signal does not fire, and byte-identical to an un-updated caller', () => {
    const off = planWith(null).tasks.dormancy_suppressed[0]
    const ok = planWith(evaluateDrought(series('2026-08-31', 25, (i) => (i === 12 ? 0.80 : 0.0)), { asOfDate: '2026-08-31' })).tasks.dormancy_suppressed[0]
    const short = planWith(evaluateDrought(series('2026-08-31', 14, 0.0), { asOfDate: '2026-08-31' })).tasks.dormancy_suppressed[0]
    expect(off.drought).toBeUndefined()
    expect(off.reason).not.toMatch(/deep soak/i)
    expect(ok).toEqual(off)
    expect(short).toEqual(off)
  })
})

// ── END-TO-END: run() -> series read -> evaluate -> engine -> the STORED plan ─────────────────────
// Everything above tests one link. This drives the real nightly entry point with the flag OFF (its
// production state) and reads the note back out of the daily_plan payload that was actually written.
// Without this the chain is inferred, and an inert feature whose engine half is perfect but whose
// input never arrives is the exact failure this row keeps hitting.
const E2E_SPACE = 'sp-1'
const E2E_USER = 'user_1'
const E2E_TODAY = '2026-09-01'      // asOfDate = 2026-08-31, the last day of the real 28-day run
const E2E_PLANTINGS = [{
  id: 'bb1', name: 'Blueberry', project_id: 'pj1', status: 'harvested', container_type: 'in_ground',
  container_size: null, rain_exposed: null, variety: 'blueberry', genus: null, project: 'Beds',
  project_status: 'active', workspace_id: E2E_SPACE, crop_type_slug: 'blueberry', covered: false,
  frost_covered_resolved: false, assignee_user_id: E2E_USER, db_cadence: NO_CAL_WATER,
  last_water: '2026-07-20', last_fert: '2026-08-01', substrate_start: '2026-05-01', transplant_at: null,
}]

function e2ePg(weatherRows, deepWaterRows = []) {
  const calls = []
  return {
    calls,
    query: vi.fn(async (sql) => {
      calls.push({ sql })
      // V5-DROUGHTSPACE-001 — the deep-watering read. Checked FIRST: it is the only statement in the run
      // that selects on metadata->>'water_depth' with the ledger flag off, and it must not fall through
      // to the generic empty answer, or the wiring test below would pass against a dead wire.
      if (/water_depth/.test(sql)) return { rows: deepWaterRows }
      if (/weather_daily/.test(sql)) return { rows: /^\s*select/i.test(sql) ? weatherRows : [] }
      if (/from plants/.test(sql)) return { rows: E2E_PLANTINGS }
      if (/from spaces/.test(sql)) return { rows: [{ id: E2E_SPACE, postal_code: null, weather_lat: 42.5, weather_lng: -72.6 }] }
      return { rows: [] }
    }),
  }
}
const storedPlans = (pg) => pg.query.mock.calls
  .filter(([sql]) => /insert into daily_plan/.test(sql))
  .map(([, params]) => JSON.parse(params[2]))

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

const driveRun = (weatherRows, deepWaterRows = []) => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const pg = e2ePg(weatherRows, deepWaterRows)
  return handler.run({
    pg, today: E2E_TODAY, dryRun: false,
    geocodeZip: async () => ({ lat: 42.5, lng: -72.6 }),
    fetchNWS: async () => ({ tonightLow: 60, highToday: 80, code: 1, unit: 'F', short: 'Clear' }),
    fetchPrecip: async () => ({
      forecast_lows: [null, null, null], forecast_dates: [null, null, null],
      recent_precip_in: 0, today_precip_in: 0, today_pop: 0, upcoming_precip_in: 0,
      tomorrow_precip_in: 0, tomorrow_pop: 0, yesterday_precip_actual_in: 0, settled_days: [],
    }),
    fetchStation: async () => null, publishAlert: vi.fn(async () => ({ messageId: 'm1' })),
    etHour: 2, event: { rainLog: false },
  }).then(() => pg)
}

describe('END-TO-END — the note reaches the STORED plan with CARE_WATER_LEDGER_ENABLED unset', () => {
  it('fires through run(): the real archive series lands as a drought note on the stored row', async () => {
    // The flag is deliberately NOT stubbed. This is production's configuration: absent from the live
    // garden-daily-plan env, so weatherDaily is null and the ledger fold never runs — and the drought
    // signal must still arrive.
    expect(process.env.CARE_WATER_LEDGER_ENABLED).toBeUndefined()
    const pg = await driveRun(REAL_AUG_2026)
    const [stored] = storedPlans(pg)
    expect(stored).toBeTruthy()
    expect(stored.counts.dormancy_suppressed).toBe(1)
    const row = stored.dormancy_suppressed[0]
    expect(row.id).toBe('bb1')
    expect(row.reason).toMatch(/no deep soak \(>=0\.60 in of rain in one day\) in 28 days/)
    expect(row.drought).toMatchObject({ dry_days: 28, deep_soak_in: 0.60, last_deep_soak: '2026-08-03' })
  })

  // ── V5-DROUGHTSPACE-001 wiring. These are the only proof that the new read is LIVE rather than
  // merely written: the pure evaluator above would pass identically if the handler never called it,
  // never intersected against the Space's plantings, or never spread the key onto the stored row.
  it('the SPACE-LEVEL line lands on the stored plan, ONCE, alongside the per-plant note', async () => {
    const pg = await driveRun(REAL_AUG_2026)
    const [stored] = storedPlans(pg)
    expect(stored.drought).toMatchObject({ dry_days: 28, deep_soak_in: 0.60, last_deep_soak: '2026-08-03' })
    expect(stored.drought.note).toMatch(/garden/i)
    expect(stored.drought.note).toMatch(/deep soak/i)
    expect(stored.drought.note).not.toMatch(/no rain in/i)
    // ONE line for the garden, not one per planting: the key is a single object on the row.
    expect(Array.isArray(stored.drought)).toBe(false)
  })

  it('a logged deep watering of the whole Space silences BOTH surfaces through run()', async () => {
    // The e2e Space has one planting, so one deep watering is the whole garden. This is the wiring
    // proof for the watering path: the read, the intersection, the reset, and the absent payload key.
    const pg = await driveRun(REAL_AUG_2026, [{ date: '2026-08-24', plant_id: 'bb1' }])
    const [stored] = storedPlans(pg)
    expect(stored.drought).toBeUndefined()                        // absent, not null — conditional spread
    expect(stored.dormancy_suppressed[0].drought).toBeUndefined()
    expect(stored.dormancy_suppressed[0].reason).not.toMatch(/deep soak/i)
  })

  it('a deep watering of a planting in ANOTHER Space does not silence this one', async () => {
    // The intersection is what makes the fraction meaningful. Without it, any deep watering anywhere
    // would reset every garden's line, and this test is the only place that fails if it is dropped.
    const pg = await driveRun(REAL_AUG_2026, [{ date: '2026-08-24', plant_id: 'not-in-this-space' }])
    const [stored] = storedPlans(pg)
    expect(stored.drought).toMatchObject({ dry_days: 28 })
  })

  it('the drought read issues exactly ONE watering statement per run, and it is not the ledger read', async () => {
    // CARE_WATER_LEDGER_ENABLED is unset, so readLedgerEvents must never run. A second water_depth
    // statement here would mean the drought path had quietly armed the flag-gated fold.
    const pg = await driveRun(REAL_AUG_2026)
    const waterSelects = pg.query.mock.calls.map(([sql]) => sql).filter((s) => /water_depth/.test(s))
    expect(waterSelects).toHaveLength(1)
    expect(waterSelects[0]).toMatch(/America\/New_York/)          // ET civil days, not the GMT session
    expect(waterSelects[0]).toMatch(/event_type = 'watering'/)
    // The refusal, as a wire-level assertion: no statement in the run reads rain events for the drought
    // signal. Only logRainEvents may mention 'rain', and this run suppresses it.
    expect(pg.query.mock.calls.map(([sql]) => sql).filter((s) => /event_type = 'rain'/.test(s))).toHaveLength(0)
  })

  it('does NOT fire through run() when the returned window is too short — no false negative on the row', async () => {
    // The window you ASK for and the window you RECEIVE are different questions. Here the read comes
    // back with 14 days; a counter that trusted the request would report "no deep soak in 14 days".
    const pg = await driveRun(REAL_AUG_2026.filter((r) => r.date >= '2026-08-18' && r.date <= '2026-08-31'))
    const [stored] = storedPlans(pg)
    expect(stored.counts.dormancy_suppressed).toBe(1)
    expect(stored.dormancy_suppressed[0].reason).not.toMatch(/deep soak/i)
    expect(stored.dormancy_suppressed[0].drought).toBeUndefined()
  })
})
