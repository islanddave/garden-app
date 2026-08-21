// V4-SEASONRETRO-001 (Track B / B13) — season retrospective generator.
//
// REAL-CORPUS VALIDATION, run out of tree 2026-08-21 and recorded here because the corpus is Dave's
// private garden data and this is a public repo (same convention as scripts/verify-metadata-strip.mjs
// for photos). The 792-row 2026 season was pulled from prod Neon, fed through the REAL
// lambda/harvests/aggregate.js computeAggregates, and into summarizeSeason. Every figure was
// cross-checked against independent SQL rather than against the generator's own output:
//
//     total picks 792 · 29 crops · 98 varieties · Tomato 320 across 34 varieties
//     peak week 2026-08-10 with 171 picks · 23 varieties with exactly one pick
//
// All six matched independently-run SQL exactly. The 792/29/98 figures differ from a naive
// 796/31/100 by precisely the archived-plantings exclusion the aggregate query applies — an
// explainable delta, checked rather than waved at.
//
// That run is also what produced the two name defects fixed in harvestPost.js: the draft's first
// line read "June 7 — Scallion (thin clump)" and its crop breakdown said "Summer Squashes". Neither
// was visible in the code; both were visible the moment real names went through it.
import { describe, it, expect } from 'vitest'
import {
  summarizeSeason, renderSeasonRetro, formatDay, IN_PROGRESS_DAYS, MIN_VARIETIES_TO_COUNT,
} from '../lib/seasonRetro.js'

// `units[].count` is an EVENT count and `total` is a quantity sum. Keeping them different in every
// fixture is deliberate: a fixture where they happen to be equal cannot fail if the code reads the
// wrong one, which is the single most likely mistake in this file.
const u = (unit, count, total) => ({ unit, unit_key: unit, total, count })

const variety = (id, name, picks, { unquantified = 0 } = {}) => ({
  variety_id: id,
  variety_name: name,
  units: picks - unquantified > 0 ? [u('count', picks - unquantified, (picks - unquantified) * 7)] : [],
  unquantified,
})

const agg = ({ weekly = [], crops = [], first_pick = [] } = {}) => ({ weekly, crops, first_pick })

// A crop's own pick count is DERIVED from its varieties rather than passed in, so the fixture cannot
// drift into a state where the crop total and the varieties under it disagree — which is the exact
// class of bug (a total that does not equal the rows beneath it) this feature would otherwise ship.
// The quantity totals stay deliberately unequal to the counts; see the note on `u`.
const cropNode = (slug, name, weeks, varieties) => {
  const picks = varieties.reduce((n, v) => n + v.units.reduce((k, x) => k + x.count, 0) + v.unquantified, 0)
  const weekTotal = weeks.reduce((n, [, c]) => n + c, 0)
  if (picks !== weekTotal) throw new Error(`fixture is inconsistent for ${name}: varieties=${picks} weeks=${weekTotal}`)
  return {
    crop_type_slug: slug,
    crop_name: name,
    weekly: weeks.map(([week_start, count]) => ({ week_start, count })),
    varieties,
    units: [u('count', picks, picks * 13)],
    unquantified: 0,
  }
}

const BASE = agg({
  weekly: [
    { week_start: '2026-07-06', count: 5 },
    { week_start: '2026-07-13', count: 12 },
    { week_start: '2026-07-20', count: 6 },
  ],
  crops: [
    cropNode('tomato', 'Tomato', [['2026-07-06', 4], ['2026-07-13', 10]], [
      variety('v1', 'Moskvich Heirloom', 8),
      variety('v2', 'Armageddon F1', 3),
      variety('v3', 'Eva Purple Ball', 1),
      variety('v4', 'Floradade', 1),
      // A one-pick variety whose NAME can never publish. Prod really carries this shape
      // ("Strawberry (unknown variety)"). It is what makes the count-but-do-not-name path real:
      // without it, every one-off in the fixture is printable and that branch never runs.
      variety('v7', 'Tomato (unknown variety)', 1),
    ]),
    cropNode('summer-squash', 'Summer Squash', [['2026-07-13', 2], ['2026-07-20', 6]], [
      variety('v5', 'Dark Green Zucchini', 8),
    ]),
    cropNode('scallion', 'Onion (bunching / scallion)', [['2026-07-06', 1]], [
      variety('v6', 'Scallion (thin clump)', 1),
    ]),
  ],
  first_pick: [
    { plant_id: 'p1', planting_name: 'Dark Green Zucchini', crop_type_slug: 'summer-squash', first_pick_date: '2026-07-15', units: [u('count', 8, 56)], unquantified: 0 },
    { plant_id: 'p2', planting_name: 'Moskvich Heirloom', crop_type_slug: 'tomato', first_pick_date: '2026-07-08', units: [u('count', 8, 56)], unquantified: 0 },
    { plant_id: 'p3', planting_name: 'Strawberry (unknown variety)', crop_type_slug: 'strawberry', first_pick_date: '2026-07-06', units: [u('count', 1, 1)], unquantified: 0 },
    { plant_id: 'p4', planting_name: 'Scallion (thin clump)', crop_type_slug: 'scallion', first_pick_date: '2026-07-07', units: [u('count', 1, 1)], unquantified: 0 },
  ],
})

const IN_SEASON = { today: '2026-07-24' }     // 4 days past the last week bucket
const AFTER_SEASON = { today: '2026-12-01' }

describe('summarizeSeason', () => {
  it('returns null rather than an empty shell when nothing was picked', () => {
    expect(summarizeSeason(agg())).toBeNull()
    expect(summarizeSeason(agg({ weekly: [{ week_start: '2026-07-06', count: 0 }] }))).toBeNull()
    expect(summarizeSeason(null)).toBeNull()
  })

  it('totals picks from the weekly buckets', () => {
    expect(summarizeSeason(BASE, IN_SEASON).totalPicks).toBe(23)
  })

  it('counts picks per crop from units[].count + unquantified, NOT from the quantity total', () => {
    // The whole reason this feature needed no Lambda change. If it read `total` instead, Tomato
    // would come out at 182 (the fixture's deliberately-different quantity sum), not 14.
    const m = summarizeSeason(BASE, IN_SEASON)
    expect(m.crops.find((c) => c.slug === 'tomato').picks).toBe(14)
    expect(m.crops[0].slug).toBe('tomato')     // sorted by picks desc
  })

  it('counts a variety with no quantity at all — unquantified rows are still picks', () => {
    const one = agg({
      weekly: [{ week_start: '2026-07-06', count: 1 }],
      crops: [cropNode('kale', 'Kale', [['2026-07-06', 1]], [variety('v9', 'Lacinato', 1, { unquantified: 1 })])],
    })
    // Exactly one pick, recorded with no quantity => still a one-off, not invisible.
    expect(summarizeSeason(one, IN_SEASON).oneOff).toHaveLength(1)
  })

  it('finds the one-pick varieties and no others', () => {
    const m = summarizeSeason(BASE, IN_SEASON)
    // Eva, Floradade, Scallion and the unnameable one — NOT Moskvich (8) or Armageddon (3).
    expect(m.oneOff).toHaveLength(4)
    expect(m.oneOff.map((o) => o.name).sort()).toEqual(['', 'Eva Purple Ball', 'Floradade', 'Scallion'])
  })

  it('picks the busiest week by count', () => {
    expect(summarizeSeason(BASE, IN_SEASON).peakWeek).toEqual({ weekStart: '2026-07-13', count: 12 })
  })

  it('orders firsts by date and drops the ones that must not publish', () => {
    const m = summarizeSeason(BASE, IN_SEASON)
    expect(m.firsts.map((f) => f.name)).toEqual(['Scallion', 'Moskvich', 'Dark Green Zucchini'])
    // "Strawberry (unknown variety)" is gone entirely; "Scallion (thin clump)" survives with the
    // bookkeeping note removed. Those are different outcomes for different reasons and both matter.
    expect(m.firsts.some((f) => /unknown/i.test(f.name))).toBe(false)
    expect(m.firsts.some((f) => f.name.includes('('))).toBe(false)
  })

  it('counts uncertain-named varieties even though it will not name them', () => {
    // The count is a fact about the garden; only the string is unsafe. Dropping it would understate
    // the season to protect something that never gets rendered.
    const m = summarizeSeason(BASE, IN_SEASON)
    expect(m.varietyCount).toBe(7)
    expect(m.oneOff.filter((o) => !o.name)).toHaveLength(1)
  })
})

describe('summarizeSeason — in-progress detection', () => {
  it('calls a season with a recent pick STILL RUNNING', () => {
    expect(summarizeSeason(BASE, IN_SEASON).inProgress).toBe(true)
  })

  it('calls a long-finished season finished', () => {
    expect(summarizeSeason(BASE, AFTER_SEASON).inProgress).toBe(false)
  })

  it('flips exactly at the threshold, and errs toward "still running"', () => {
    // last week bucket is 2026-07-20.
    const at = summarizeSeason(BASE, { today: '2026-08-03' })   // exactly IN_PROGRESS_DAYS later
    const past = summarizeSeason(BASE, { today: '2026-08-04' })
    expect(IN_PROGRESS_DAYS).toBe(14)
    expect(at.inProgress).toBe(true)      // boundary is inclusive: a mistake here should not
    expect(past.inProgress).toBe(false)   // declare a producing garden finished
  })

  it('treats an unreadable last week as still running rather than finished', () => {
    const m = summarizeSeason(agg({ weekly: [{ week_start: null, count: 3 }] }), AFTER_SEASON)
    expect(m.inProgress).toBe(true)
  })
})

describe('renderSeasonRetro', () => {
  it('never writes the garden off while it is still producing', () => {
    const text = renderSeasonRetro(summarizeSeason(BASE, IN_SEASON))
    expect(text).toContain('so far')
    expect(text).not.toMatch(/^The season in numbers/)
  })

  it('uses finished framing only once the season really is over', () => {
    const text = renderSeasonRetro(summarizeSeason(BASE, AFTER_SEASON))
    expect(text).toContain('The season in numbers')
    expect(text).not.toContain('so far')
  })

  it('states the headline totals', () => {
    const text = renderSeasonRetro(summarizeSeason(BASE, IN_SEASON))
    expect(text).toContain('23 harvests')
    expect(text).toContain('3 crops')
    expect(text).toContain('7 varieties')
  })

  it('pluralises crop names through the shared resolver, qualifiers and all', () => {
    const text = renderSeasonRetro(summarizeSeason(BASE, IN_SEASON))
    expect(text).toContain('Tomatoes: 14')
    expect(text).toContain('Summer Squash: 8')          // invariant plural survives the qualifier
    expect(text).not.toContain('Summer Squashes')
    expect(text).not.toContain('scallion)s')            // crop-name parenthetical, not a plural
  })

  it('omits the variety count for a crop with too few to be worth counting', () => {
    const text = renderSeasonRetro(summarizeSeason(BASE, IN_SEASON))
    expect(MIN_VARIETIES_TO_COUNT).toBe(3)
    expect(text).toContain('Tomatoes: 14 across 5 varieties')
    expect(text).toMatch(/Summer Squash: 8(\n|$)/)      // 1 variety — no "across 1 varieties"
  })

  it('names the one-off varieties it can and counts the ones it cannot', () => {
    const text = renderSeasonRetro(summarizeSeason(BASE, IN_SEASON))
    expect(text).toContain('4 varieties gave exactly one pick')
    expect(text).toContain('Eva Purple Ball')
    expect(text).toContain('and others')                // the unnameable third is not silently lost
  })

  it('caps the firsts list and says it capped it', () => {
    const text = renderSeasonRetro(summarizeSeason(BASE, IN_SEASON), { maxFirsts: 2 })
    expect(text).toContain('first 2 of 3')
    expect(text).toContain('Scallion')
    expect(text).not.toContain('Dark Green Zucchini')
  })

  it('emits plain text — a composer renders markdown as literal asterisks', () => {
    const text = renderSeasonRetro(summarizeSeason(BASE, IN_SEASON))
    expect(text).not.toMatch(/[*_#]/)
  })

  it('renders nothing for a null model rather than throwing', () => {
    expect(renderSeasonRetro(null)).toBe('')
  })
})

describe('formatDay', () => {
  it('abbreviates the months Dave abbreviates and spells out the ones he spells', () => {
    expect(formatDay('2026-06-04')).toBe('June 4')
    expect(formatDay('2026-08-21')).toBe('Aug 21')
    expect(formatDay('2026-03-09')).toBe('March 9')
  })

  it('does not shift the day across a DST boundary', () => {
    // Parsed at noon precisely so no zone offset can roll the calendar date backwards.
    expect(formatDay('2026-03-08')).toBe('March 8')
    expect(formatDay('2026-11-01')).toBe('Nov 1')
  })

  it('returns empty for junk rather than "Invalid Date"', () => {
    expect(formatDay(null)).toBe('')
    expect(formatDay('not-a-date')).toBe('')
  })
})
