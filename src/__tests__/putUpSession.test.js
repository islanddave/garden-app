// V4-PUTUPSESSION-001 slice 0 — the freezer walk's pure half.
//
// Everything here is falsifiable in jsdom: date arithmetic, the "what haven't I put up" set
// difference, and the two localStorage stores. The walk's GEOMETRY is
// not testable here and is not claimed to be (tests/harness/README.md:14-16 — getBoundingClientRect
// returns zeros in jsdom), which is why the band's height is measured at runtime rather than pinned
// to a constant this file could pretend to certify.
import { describe, it, expect, beforeEach } from 'vitest'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

import {
  coarseDate, exactDate, describeApprox, unrecordedCrops,
  readWalk, writeWalk, clearWalk, readDismissed, dismissCrop,
} from '../lib/putUpSession.js'

describe('coarseDate — the two answers a freezer walk can actually give', () => {
  it('"this summer" is the midpoint of Jun 1 .. Aug 31 and is flagged approximate', () => {
    expect(coarseDate('summer', '2026-08-31')).toEqual({ date: '2026-07-16', approx: true })
  })

  it('clamps the window to TODAY so it can never propose a future put-up date', () => {
    // Mid-season: the window is Jun 1 .. today, not Jun 1 .. Aug 31. The form's own
    // `max={todayYMD()}` says a put-up cannot be in the future and this has to agree with it.
    expect(coarseDate('summer', '2026-07-01')).toEqual({ date: '2026-06-16', approx: true })
  })

  it('returns null before the window has opened, rather than a date in the future', () => {
    // Asked in March, "this summer" has no honest answer. The caller drops the button.
    expect(coarseDate('summer', '2026-03-01')).toBeNull()
  })

  it('"earlier this year" is the midpoint of Jan 1 .. May 31', () => {
    expect(coarseDate('earlier', '2026-08-31')).toEqual({ date: '2026-03-17', approx: true })
  })

  it('crosses the March DST boundary without sliding a day', () => {
    // The regression this guards: computing the span in local time makes it 23 hours short across
    // the spring-forward, which moves the answer to Mar 16 for no reason a reader could guess.
    expect(coarseDate('earlier', '2026-12-31').date).toBe('2026-03-17')
  })

  it('is null for an unknown choice', () => {
    expect(coarseDate('whenever', '2026-08-31')).toBeNull()
  })
})

// Put-Up R2b: describeDate (the retired "Log a put-up" form's formatter) is gone; describeApprox is the one
// place the word lives, and the read surfaces format the date themselves before marking it.
describe('exactDate / describeApprox — an estimate never wears the same words as a chosen date', () => {
  it('a picked date is NOT approximate', () => {
    expect(exactDate('2026-07-04')).toEqual({ date: '2026-07-04', approx: false })
  })
  it('an empty pick is null, not a silent today', () => {
    expect(exactDate('')).toBeNull()
  })

  // V4-PUTUPSESSION-001 slice 1 — the read surfaces mark an ALREADY-FORMATTED date, because both of
  // them get a JS Date object back from the neon driver.
  it('describeApprox marks a pre-formatted date: "around" only for an estimate', () => {
    expect(describeApprox('Jul 16, 2026', true)).toBe('around Jul 16, 2026')
    expect(describeApprox('Jul 16, 2026', false)).toBe('Jul 16, 2026')
  })

  // NULL is not FALSE. Every row written before the column existed carries NULL, and a read surface
  // that tested truthiness-vs-nullishness rather than `=== true` would be right by accident here and
  // wrong the moment somebody wrote `approx ?? true` or `!approx`.
  it('an unrecorded flag renders exactly like a chosen date', () => {
    expect(describeApprox('Jul 16, 2026', null)).toBe('Jul 16, 2026')
    expect(describeApprox('Jul 16, 2026', undefined)).toBe('Jul 16, 2026')
  })
})

describe('unrecordedCrops — a list that can never become a forever nag', () => {
  const harvestCrops = [
    { crop_type_slug: 'blueberry', crop_name: 'Blueberries' },
    { crop_type_slug: 'watermelon', crop_name: 'Watermelon' },
    { crop_type_slug: 'squash', crop_name: 'Squash' },
  ]

  it('lists crops picked with nothing put up', () => {
    const rows = unrecordedCrops({ harvestCrops, putUpSlugs: ['squash'], dismissed: [] })
    expect(rows.map(r => r.slug)).toEqual(['blueberry', 'watermelon'])
  })

  it('DROPS a dismissed crop — Dave: "i pick watermelons but mostly eat them fresh"', () => {
    const rows = unrecordedCrops({ harvestCrops, putUpSlugs: ['squash'], dismissed: ['watermelon'] })
    expect(rows.map(r => r.slug)).toEqual(['blueberry'])
  })

  it('falls back to the slug when a crop has no display name, and tolerates empty inputs', () => {
    expect(unrecordedCrops({ harvestCrops: [{ crop_type_slug: 'dill' }] })).toEqual([{ slug: 'dill', name: 'dill' }])
    expect(unrecordedCrops({})).toEqual([])
  })
})

describe('the walk stash — it has to survive the launcher discarding the tab', () => {
  beforeEach(() => { localStorage.clear() })

  it('round-trips the two session answers and the place', () => {
    writeWalk({ storageId: 'loc-1', date: '2026-07-16', dateApprox: true, cropSlug: 'blueberry', savedCount: 3 })
    expect(readWalk()).toMatchObject({
      v: 1, storageId: 'loc-1', date: '2026-07-16', dateApprox: true, cropSlug: 'blueberry', savedCount: 3,
    })
  })

  it('refuses a stash with no date answer — it could not skip the setup screen honestly', () => {
    localStorage.setItem('garden:putup-walk:v1', JSON.stringify({ v: 1, storageId: 'loc-1' }))
    expect(readWalk()).toBeNull()
  })

  it('refuses a stash from a different version, and survives garbage', () => {
    localStorage.setItem('garden:putup-walk:v1', JSON.stringify({ v: 99, date: '2026-07-16' }))
    expect(readWalk()).toBeNull()
    localStorage.setItem('garden:putup-walk:v1', 'not json')
    expect(readWalk()).toBeNull()
  })

  it('clearWalk means the next entry starts fresh', () => {
    writeWalk({ date: '2026-07-16' })
    clearWalk()
    expect(readWalk()).toBeNull()
  })
})

describe('the "not one I put up" store — the dismissal has to STICK', () => {
  beforeEach(() => { localStorage.clear() })

  it('persists across reads and de-duplicates', () => {
    dismissCrop('watermelon')
    dismissCrop('watermelon')
    dismissCrop('cucamelon')
    expect(readDismissed()).toEqual(['watermelon', 'cucamelon'])
  })

  it('ignores an empty slug and returns the current set', () => {
    dismissCrop('watermelon')
    expect(dismissCrop('')).toEqual(['watermelon'])
  })

  it('reads as empty when nothing is stored or the value is malformed', () => {
    expect(readDismissed()).toEqual([])
    localStorage.setItem('garden:putup-not-mine:v1', JSON.stringify({ v: 1, slugs: 'nope' }))
    expect(readDismissed()).toEqual([])
  })
})
