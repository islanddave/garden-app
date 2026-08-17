// V4-STORAGEDEADLINE-001 — seasonal lift deadlines for 'single'-habit storage crops.
//
// These tests execute the resolver's behaviour. The four that guard the ITEM rather than the code are
// worth naming, because they are the ones that would let a wrong deadline ship if deleted:
//   1. the frost GROUNDING block at the foot of this file — the deadline must sit between the earliest
//      and median first frost in its own reproducible measurement. It replaced two successive versions
//      of an anchor-ORDERING guard that pinned a rationale and passed while the date was wrong twice,
//   2. the provenance invariant — no dated record without source + url + confidence,
//   3. the check-form copy rule — no copy may assert readiness,
//   4. the live-slug guard — a dated record under a dead slug can never fire.

import { describe, it, expect } from 'vitest'
import {
  DEADLINES_BY_CROP_TYPE, NO_CALENDAR_DEADLINE,
  PHASE_UPCOMING, PHASE_CHECK, PHASE_PAST,
  resolveMonthDay, resolveStorageDeadline, hasExaminedNoDeadline,
  storageDeadlineStatus, plantingsWithOpenDeadline,
} from '../lib/storageDeadlines.js'
import { FROST_ANCHORS } from '../lib/sowEngine.js'
import { CROP_TYPE_SLUGS } from '../lib/parseSowProfile.js'

const sweetPotato = () => DEADLINES_BY_CROP_TYPE.sweet_potato
const vref = slug => ({ crop_type_slug: slug })

describe('resolveStorageDeadline', () => {
  it('resolves the one sourced crop', () => {
    expect(resolveStorageDeadline(vref('sweet_potato'))).toBe(sweetPotato())
  })
  it('returns null for a crop with no sourced deadline (the common case)', () => {
    expect(resolveStorageDeadline(vref('tomato'))).toBeNull()
    expect(resolveStorageDeadline(vref('carrot'))).toBeNull()
    expect(resolveStorageDeadline(vref('winter_squash'))).toBeNull()
  })
  it('returns null for absent or slugless input rather than throwing', () => {
    expect(resolveStorageDeadline(null)).toBeNull()
    expect(resolveStorageDeadline(undefined)).toBeNull()
    expect(resolveStorageDeadline({})).toBeNull()
  })
})

describe('hasExaminedNoDeadline', () => {
  it('is true for crops deliberately given no date', () => {
    expect(hasExaminedNoDeadline('onion')).toBe(true)
    expect(hasExaminedNoDeadline('carrot')).toBe(true)
    expect(hasExaminedNoDeadline('winter_squash')).toBe(true)
  })
  it('does not leak the dataset _note key as a crop', () => {
    expect(hasExaminedNoDeadline('_note')).toBe(false)
  })
  it('is false for a crop never examined, and for empty input', () => {
    expect(hasExaminedNoDeadline('pepper')).toBe(false)
    expect(hasExaminedNoDeadline('')).toBe(false)
    expect(hasExaminedNoDeadline(undefined)).toBe(false)
  })
})

describe('resolveMonthDay', () => {
  it('joins a valid MM-DD to a year', () => {
    expect(resolveMonthDay('10-15', 2026)).toBe('2026-10-15')
  })
  it('rejects a calendar-invalid day instead of rolling it over', () => {
    expect(resolveMonthDay('02-30', 2026)).toBeNull()
    expect(resolveMonthDay('13-01', 2026)).toBeNull()
  })
  it('honours real leap-year rules in both directions', () => {
    expect(resolveMonthDay('02-29', 2024)).toBe('2024-02-29')
    expect(resolveMonthDay('02-29', 2026)).toBeNull()
  })
  it('rejects malformed shapes and non-integer years', () => {
    expect(resolveMonthDay('10-5', 2026)).toBeNull()
    expect(resolveMonthDay(null, 2026)).toBeNull()
    expect(resolveMonthDay('10-15', 2026.5)).toBeNull()
  })
})

describe('storageDeadlineStatus — phases', () => {
  const rec = () => sweetPotato()

  it('is `upcoming` and CARRIES NO COPY before the check window opens', () => {
    const s = storageDeadlineStatus(rec(), '2026-08-12')
    expect(s.phase).toBe(PHASE_UPCOMING)
    expect(s.copy).toBeNull()
  })
  it('is `upcoming` on the day BEFORE the check window opens (boundary)', () => {
    expect(storageDeadlineStatus(rec(), '2026-09-27').phase).toBe(PHASE_UPCOMING)
  })
  it('turns `check` exactly ON the check-from date (boundary) and speaks', () => {
    const s = storageDeadlineStatus(rec(), '2026-09-28')
    expect(s.phase).toBe(PHASE_CHECK)
    expect(s.copy).toBe(rec().check_copy)
  })
  it('is still `check` ON the deadline itself — there is time left that day', () => {
    expect(storageDeadlineStatus(rec(), '2026-10-10').phase).toBe(PHASE_CHECK)
  })
  it('turns `past` the day AFTER the deadline (boundary) with the past copy', () => {
    const s = storageDeadlineStatus(rec(), '2026-10-11')
    expect(s.phase).toBe(PHASE_PAST)
    expect(s.copy).toBe(rec().past_copy)
  })
  it('resolves the deadline against the CALLER year, not a hardcoded one', () => {
    expect(storageDeadlineStatus(rec(), '2031-10-01').deadlineISO).toBe('2031-10-10')
    expect(storageDeadlineStatus(rec(), '2031-10-01').phase).toBe(PHASE_CHECK)
  })
  it('counts days until the deadline, signed past it', () => {
    expect(storageDeadlineStatus(rec(), '2026-09-28').daysUntil).toBe(12)
    expect(storageDeadlineStatus(rec(), '2026-10-10').daysUntil).toBe(0)
    expect(storageDeadlineStatus(rec(), '2026-10-11').daysUntil).toBe(-1)
  })
  it('surfaces provenance alongside the phase so a caller can render it', () => {
    const s = storageDeadlineStatus(rec(), '2026-09-12')
    expect(s.source).toBe(rec().source)
    expect(s.sourceUrl).toBe(rec().source_url)
    expect(s.confidence).toBe(rec().confidence)
    expect(s.trueTrigger).toBe(rec().true_trigger)
  })
})

describe('storageDeadlineStatus — UNKNOWN never fires', () => {
  it('returns null for an absent record', () => {
    expect(storageDeadlineStatus(null, '2026-10-02')).toBeNull()
    expect(storageDeadlineStatus(undefined, '2026-10-02')).toBeNull()
  })
  it('returns null for an unparseable or absent today', () => {
    expect(storageDeadlineStatus(sweetPotato(), 'tomorrow')).toBeNull()
    expect(storageDeadlineStatus(sweetPotato(), '2026-13-40')).toBeNull()
    expect(storageDeadlineStatus(sweetPotato(), null)).toBeNull()
    expect(storageDeadlineStatus(sweetPotato(), '')).toBeNull()
  })
  it('returns null when the record has no usable dates', () => {
    expect(storageDeadlineStatus({ deadline_month_day: 'mid-Oct', check_from_month_day: '10-01' }, '2026-10-02')).toBeNull()
    expect(storageDeadlineStatus({ deadline_month_day: '10-15' }, '2026-10-02')).toBeNull()
  })
  it('refuses a check window that does not open before its own deadline', () => {
    expect(storageDeadlineStatus({ deadline_month_day: '10-15', check_from_month_day: '10-15' }, '2026-10-02')).toBeNull()
    expect(storageDeadlineStatus({ deadline_month_day: '10-15', check_from_month_day: '10-20' }, '2026-10-02')).toBeNull()
  })
})

describe('dataset invariants', () => {
  const dated = Object.entries(DEADLINES_BY_CROP_TYPE)

  it('has at least one dated crop, and every one of them is resolvable', () => {
    expect(dated.length).toBeGreaterThan(0)
    for (const [slug, rec] of dated) {
      expect(resolveStorageDeadline(vref(slug)), slug).toBe(rec)
      expect(storageDeadlineStatus(rec, '2026-06-01'), slug).not.toBeNull()
    }
  })

  // PROVENANCE INVARIANT. A date with no source is the failure mode this whole item was re-scoped to
  // avoid; adding one to the JSON must break the build, not ship quietly.
  it('every dated crop carries a source, a URL and a confidence', () => {
    for (const [slug, rec] of dated) {
      expect(rec.source, slug).toBeTruthy()
      expect(String(rec.source_url), slug).toMatch(/^https:\/\//)
      expect(['high', 'medium', 'low'], slug).toContain(rec.confidence)
      expect(rec.true_trigger, slug).toBeTruthy()
    }
  })

  // CHECK-FORM COPY RULE. The estimates here are weak; copy that asserts readiness overclaims them.
  it('no copy asserts readiness — check form only', () => {
    const assertion = /\b(is|are|now)\s+(ready|ripe|due)\b|\bready to\b|\btime to harvest\b/i
    for (const [slug, rec] of dated) {
      for (const key of ['check_copy', 'past_copy']) {
        expect(rec[key], `${slug}.${key}`).toBeTruthy()
        expect(assertion.test(rec[key]), `${slug}.${key} must not assert readiness`).toBe(false)
      }
    }
  })

  it('every check window opens strictly before its deadline', () => {
    for (const [slug, rec] of dated) {
      expect(String(rec.check_from_month_day).localeCompare(String(rec.deadline_month_day)), slug).toBeLessThan(0)
    }
  })

  it('records a reason and a needed-signal for every crop deliberately left undated', () => {
    const examined = Object.entries(NO_CALENDAR_DEADLINE).filter(([k]) => k !== '_note')
    expect(examined.length).toBeGreaterThan(0)
    for (const [slug, rec] of examined) {
      expect(rec.finding, slug).toBeTruthy()
      expect(rec.needed, slug).toBeTruthy()
      // A crop cannot be both dated and disconfirmed.
      expect(Object.hasOwn(DEADLINES_BY_CROP_TYPE, slug), slug).toBe(false)
    }
  })
})

// THE GUARD THAT MATTERS MOST — REBUILT, because for two versions running it pinned a RATIONALE.
//
// History, because it is the whole reason this block now looks the way it does. 1.0.0 asserted the
// deadline must land strictly LATER than FROST_ANCHORS.firstFallFrost (soil-temperature reading).
// 1.1.0 inverted it to strictly EARLIER (vine-kill reading) and added a "sits 3 days ahead" test whose
// body was `expect((Date.UTC(2026,8,28) - Date.UTC(2026,8,25)) / 86400000).toBe(3)` — arithmetic on two
// hardcoded literals, structurally unable to fail, guarding nothing. Both versions were green. Both
// dates were derived from the anchor. Both were wrong, in opposite directions.
//
// THE ANCHOR IS NOT A MEASUREMENT. `firstFallFrost` is a conservative SOWING-safety margin: it decides
// whether a sowing can finish, so being early is free there. Measured at this site over 11 years the
// first <=32F night falls 10-10..11-08, median 10-29 — the anchor runs 12 to 41 days ahead of any frost
// that has actually happened. A harvest cutoff derived from it forfeits real bulking weeks every year.
// So this block no longer asserts ANY relation between the deadline and the anchor. It asserts the
// deadline is bounded by the record's own reproducible measurement, and it asserts the behaviour that
// falls out of that. `FROST_ANCHORS` is still imported deliberately, for the one test that pins the
// independence itself — if that import ever becomes unused, someone has quietly re-coupled them.
describe('frost grounding — the date is bounded by measurement, not by the anchor', () => {
  // Structural. A dated record whose date is not a phrase its own source states MUST carry a
  // reproducible basis; adding one without it breaks the build rather than shipping another rationale.
  it('every measured_site_backstop carries a reproducible measured_basis', () => {
    for (const [slug, rec] of Object.entries(DEADLINES_BY_CROP_TYPE)) {
      if (rec.deadline_kind !== 'measured_site_backstop') continue
      const b = rec.measured_basis
      expect(b, `${slug}.measured_basis`).toBeTruthy()
      // A query someone can actually re-run. Coordinates and a variable, not a citation.
      expect(String(b.query), `${slug}.query`).toMatch(/^GET https:\/\//)
      expect(String(b.query), `${slug}.query must carry the site coordinates`).toMatch(/latitude=42\.5087.*longitude=-72\.6471/)
      expect(String(b.source_url), slug).toMatch(/^https:\/\//)
      expect(b.years, `${slug}.years`).toBeGreaterThanOrEqual(10)
      for (const k of ['first_frost_earliest_month_day', 'first_frost_median_month_day']) {
        expect(String(b[k]), `${slug}.${k}`).toMatch(/^\d{2}-\d{2}$/)
      }
      // The per-year table must actually contain `years` rows, and its own min must be the stated
      // earliest — so a summary statistic cannot drift away from the data it claims to summarise.
      const byYear = Object.values(b.first_frost_by_year ?? {})
      expect(byYear, `${slug}.first_frost_by_year`).toHaveLength(b.years)
      expect([...byYear].sort()[0], `${slug} earliest must be the min of its own table`)
        .toBe(b.first_frost_earliest_month_day)
    }
  })

  // THE SUBSTANTIVE GUARD, both sides. Below the earliest OBSERVED frost the deadline is firing before
  // the hazard has ever existed (the 09-25 defect). Above the MEDIAN it is betting on a late frost in a
  // year that owes it nothing. Between the two it is a backstop, which is what it claims to be.
  it('every dated deadline sits between its own earliest-observed and median first frost', () => {
    for (const [slug, rec] of Object.entries(DEADLINES_BY_CROP_TYPE)) {
      const b = rec.measured_basis
      if (!b) continue
      expect(rec.deadline_month_day.localeCompare(b.first_frost_earliest_month_day),
        `${slug}: deadline fires before frost has EVER occurred here`).toBeGreaterThanOrEqual(0)
      expect(rec.deadline_month_day.localeCompare(b.first_frost_median_month_day),
        `${slug}: deadline is past the median first frost — no longer a backstop`).toBeLessThanOrEqual(0)
    }
  })

  // BEHAVIOUR, not prose: on the anchor date the alert must still be OPEN. This is what 09-25 broke —
  // it put the crop in `past` on 09-28, i.e. the app declared the window shut ~5 weeks before the
  // median frost. Reads through the resolver, so it fails on a date change or a resolver change alike.
  it('the alerting anchor does not close the lift window', () => {
    for (const [slug, rec] of Object.entries(DEADLINES_BY_CROP_TYPE)) {
      const s = storageDeadlineStatus(rec, `2026-${FROST_ANCHORS.firstFallFrost}`)
      expect(s, slug).not.toBeNull()
      expect(s.phase, `${slug} must not already be past on the frost anchor`).not.toBe(PHASE_PAST)
    }
  })

  // The lead time is a real user-facing quantity — the days between "start checking" and "or lose it".
  // Pinned as a minimum through the resolver rather than as a hardcoded pair of dates.
  it('gives at least a week of lead between the check window opening and the deadline', () => {
    for (const [slug, rec] of Object.entries(DEADLINES_BY_CROP_TYPE)) {
      const s = storageDeadlineStatus(rec, `2026-${rec.check_from_month_day}`)
      expect(s.phase, slug).toBe(PHASE_CHECK)
      expect(s.daysUntil, `${slug} lead time`).toBeGreaterThanOrEqual(7)
    }
  })

  // Where the true trigger is a weather EVENT, the record must say what to do when it is forecast.
  // Without this the date reads as the instruction, which is the misreading that produced 1.0.0.
  it('a weather-triggered deadline states the forecast action, so the date is not read as the trigger', () => {
    for (const [slug, rec] of Object.entries(DEADLINES_BY_CROP_TYPE)) {
      if (rec.deadline_kind !== 'measured_site_backstop') continue
      expect(rec.on_frost_action, `${slug}.on_frost_action`).toBeTruthy()
    }
  })
})

// Cross-dataset key-space guard. `resolveStorageDeadline` keys on `variety_ref.crop_type_slug`, so a
// dated record under a slug that is not a live crop type can never fire and would fail SILENTLY —
// exactly the class of defect that hides for a season. Scoped to the DATED records on purpose:
// `no_calendar_deadline` legitimately holds slugs that do not exist (bean_dry is recorded precisely
// because there is no dry-bean crop type), and asserting over those would forbid recording that.
describe('dated slugs are live crop types', () => {
  it('every dated crop is a slug the app can actually resolve a planting to', () => {
    for (const slug of Object.keys(DEADLINES_BY_CROP_TYPE)) {
      expect(CROP_TYPE_SLUGS, `${slug} is not a live crop_types slug — this deadline can never fire`)
        .toContain(slug)
    }
  })
})

describe('plantingsWithOpenDeadline', () => {
  const p = (name, slug) => ({ name, variety_ref: { crop_type_slug: slug } })

  it('keeps only crops with a sourced deadline that is currently open', () => {
    const rows = plantingsWithOpenDeadline(
      [p('Sweet Potato', 'sweet_potato'), p('Danvers 126', 'carrot'), p('Yukon Gold', 'potato')],
      '2026-10-01')
    expect(rows.map(r => r.planting.name)).toEqual(['Sweet Potato'])
    expect(rows[0].status.phase).toBe(PHASE_CHECK)
  })
  it('drops everything while the only deadline is still upcoming', () => {
    expect(plantingsWithOpenDeadline([p('Sweet Potato', 'sweet_potato')], '2026-08-12')).toEqual([])
  })
  it('sorts soonest deadline first, then by name for determinism', () => {
    const rows = plantingsWithOpenDeadline(
      [p('Sweet Potatoes', 'sweet_potato'), p('Sweet Potato', 'sweet_potato')],
      '2026-10-01')
    expect(rows.map(r => r.planting.name)).toEqual(['Sweet Potato', 'Sweet Potatoes'])
  })
  it('returns [] for non-array input rather than throwing', () => {
    expect(plantingsWithOpenDeadline(null, '2026-10-02')).toEqual([])
    expect(plantingsWithOpenDeadline(undefined, '2026-10-02')).toEqual([])
  })
})
