// V4-STORAGEDEADLINE-001 — seasonal lift deadlines for 'single'-habit storage crops.
//
// These tests execute the resolver's behaviour. The three that guard the ITEM rather than the code are
// worth naming, because they are the ones that would let a wrong deadline ship if deleted:
//   1. the frost-anchor ordering — the sourced deadline must stay strictly BEFORE FROST_ANCHORS
//      (inverted by BUG-SWEETPOTATODEADLINE-001; see the block at the foot of this file for why),
//   2. the provenance invariant — no dated record without source + url + confidence,
//   3. the check-form copy rule — no copy may assert readiness.

import { describe, it, expect } from 'vitest'
import {
  DEADLINES_BY_CROP_TYPE, NO_CALENDAR_DEADLINE,
  PHASE_UPCOMING, PHASE_CHECK, PHASE_PAST,
  resolveMonthDay, resolveStorageDeadline, hasExaminedNoDeadline,
  storageDeadlineStatus, plantingsWithOpenDeadline,
} from '../lib/storageDeadlines.js'
import { FROST_ANCHORS } from '../lib/sowEngine.js'

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
    expect(storageDeadlineStatus(rec(), '2026-09-10').phase).toBe(PHASE_UPCOMING)
  })
  it('turns `check` exactly ON the check-from date (boundary) and speaks', () => {
    const s = storageDeadlineStatus(rec(), '2026-09-11')
    expect(s.phase).toBe(PHASE_CHECK)
    expect(s.copy).toBe(rec().check_copy)
  })
  it('is still `check` ON the deadline itself — there is time left that day', () => {
    expect(storageDeadlineStatus(rec(), '2026-09-25').phase).toBe(PHASE_CHECK)
  })
  it('turns `past` the day AFTER the deadline (boundary) with the past copy', () => {
    const s = storageDeadlineStatus(rec(), '2026-09-26')
    expect(s.phase).toBe(PHASE_PAST)
    expect(s.copy).toBe(rec().past_copy)
  })
  it('resolves the deadline against the CALLER year, not a hardcoded one', () => {
    expect(storageDeadlineStatus(rec(), '2031-09-12').deadlineISO).toBe('2031-09-25')
    expect(storageDeadlineStatus(rec(), '2031-09-12').phase).toBe(PHASE_CHECK)
  })
  it('counts days until the deadline, signed past it', () => {
    expect(storageDeadlineStatus(rec(), '2026-09-11').daysUntil).toBe(14)
    expect(storageDeadlineStatus(rec(), '2026-09-25').daysUntil).toBe(0)
    expect(storageDeadlineStatus(rec(), '2026-09-26').daysUntil).toBe(-1)
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

// THE REGRESSION GUARD THAT MATTERS MOST — and it used to pin the WRONG invariant.
//
// Until BUG-SWEETPOTATODEADLINE-001 this block asserted the sweet potato deadline must be strictly
// LATER than the frost anchor, on the reading that the crop's limit is SOIL temperature and UMass's
// "usually before mid-October" was therefore the operative cutoff. Dave's ruling 2026-08-17: in zone
// 5b the binding constraint is VINE KILL. Frost blackens the vines while the soil is still warm, and
// the roots start degrading from that moment, so a deadline 17 days after the anchor fired 17 days
// after the crop was already lost. The polarity is now inverted: a frost-sensitive storage crop's
// deadline must land BEFORE the anchor.
//
// The independence half still holds and is still worth guarding. Do NOT collapse these into
// `deadline = FROST_ANCHORS.firstFallFrost`: the anchor is one regional average, the margin ahead of
// it is per-crop, and most of `no_calendar_deadline` is frost-TOLERANT and correctly has no frost
// deadline at all. Related but not derived.
describe('frost-anchor ordering', () => {
  it('every sourced deadline lands strictly BEFORE the first-fall-frost anchor', () => {
    for (const [slug, rec] of Object.entries(DEADLINES_BY_CROP_TYPE)) {
      expect(rec.deadline_month_day.localeCompare(FROST_ANCHORS.firstFallFrost), slug).toBeLessThan(0)
    }
  })
  it('sweet potato specifically sits 3 days AHEAD of the frost anchor', () => {
    expect(FROST_ANCHORS.firstFallFrost).toBe('09-28')
    const anchor = Date.UTC(2026, 8, 28)
    const deadline = Date.UTC(2026, 8, 25)
    expect((anchor - deadline) / 86400000).toBe(3)
    expect(sweetPotato().deadline_month_day).toBe('09-25')
  })
  // The exact defect BUG-SWEETPOTATODEADLINE-001 fixed, pinned by value so a revert is a red test
  // rather than a silent regression to a date that fires after the crop is gone.
  it('is not the superseded 10-15, which fell 17 days past the anchor', () => {
    expect(sweetPotato().deadline_month_day).not.toBe('10-15')
    expect(sweetPotato().check_from_month_day).toBe('09-11')
  })
  // No deadline may sit inside the vine-kill blind spot: at or after the anchor there is nothing left
  // to save, so the alert would be furniture. Guards future crops, not just this one.
  it('no dated crop is left with a deadline in the post-frost blind spot', () => {
    for (const [slug, rec] of Object.entries(DEADLINES_BY_CROP_TYPE)) {
      const s = storageDeadlineStatus(rec, `2026-${FROST_ANCHORS.firstFallFrost}`)
      expect(s, slug).not.toBeNull()
      expect(s.phase, slug).toBe(PHASE_PAST)
    }
  })
})

describe('plantingsWithOpenDeadline', () => {
  const p = (name, slug) => ({ name, variety_ref: { crop_type_slug: slug } })

  it('keeps only crops with a sourced deadline that is currently open', () => {
    const rows = plantingsWithOpenDeadline(
      [p('Sweet Potato', 'sweet_potato'), p('Danvers 126', 'carrot'), p('Yukon Gold', 'potato')],
      '2026-09-12')
    expect(rows.map(r => r.planting.name)).toEqual(['Sweet Potato'])
    expect(rows[0].status.phase).toBe(PHASE_CHECK)
  })
  it('drops everything while the only deadline is still upcoming', () => {
    expect(plantingsWithOpenDeadline([p('Sweet Potato', 'sweet_potato')], '2026-08-12')).toEqual([])
  })
  it('sorts soonest deadline first, then by name for determinism', () => {
    const rows = plantingsWithOpenDeadline(
      [p('Sweet Potatoes', 'sweet_potato'), p('Sweet Potato', 'sweet_potato')],
      '2026-09-12')
    expect(rows.map(r => r.planting.name)).toEqual(['Sweet Potato', 'Sweet Potatoes'])
  })
  it('returns [] for non-array input rather than throwing', () => {
    expect(plantingsWithOpenDeadline(null, '2026-10-02')).toEqual([])
    expect(plantingsWithOpenDeadline(undefined, '2026-10-02')).toEqual([])
  })
})
