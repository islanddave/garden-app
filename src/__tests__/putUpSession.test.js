// V4-PUTUPSESSION-001 slice 0 — the freezer walk's pure half.
//
// Everything here is falsifiable in jsdom: date arithmetic, the exactly-one-planting rule, the
// "what haven't I put up" set difference, and the two localStorage stores. The walk's GEOMETRY is
// not testable here and is not claimed to be (tests/harness/README.md:14-16 — getBoundingClientRect
// returns zeros in jsdom), which is why the band's height is measured at runtime rather than pinned
// to a constant this file could pretend to certify.
import { describe, it, expect, beforeEach } from 'vitest'
import { installStoragePolyfill } from './helpers/storagePolyfill.js'

installStoragePolyfill()

import {
  coarseDate, exactDate, describeDate, plantingsForCrop, solePlanting, unrecordedCrops,
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

describe('exactDate / describeDate — an estimate never wears the same words as a chosen date', () => {
  it('a picked date is NOT approximate', () => {
    expect(exactDate('2026-07-04')).toEqual({ date: '2026-07-04', approx: false })
  })
  it('an empty pick is null, not a silent today', () => {
    expect(exactDate('')).toBeNull()
  })
  it('prefixes "around" only for an estimate', () => {
    expect(describeDate('2026-07-16', true)).toMatch(/^around /)
    expect(describeDate('2026-07-16', false)).not.toMatch(/^around /)
    expect(describeDate('', true)).toBe('')
  })
})

const PLANTS = [
  { id: 'p-blue', variety_ref: { crop_type_slug: 'blueberry' } },
  { id: 'p-tom-1', variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'p-tom-2', variety_ref: { crop_type_slug: 'tomato' } },
  { id: 'p-none' },
]

describe('solePlanting — auto-resolution only where there is nothing to choose', () => {
  it('returns the single planting for a one-planting crop (18 of 31 crops, measured)', () => {
    expect(solePlanting(PLANTS, 'blueberry').id).toBe('p-blue')
  })
  it('returns null when the crop has two — two is a CHOICE and the app must ask', () => {
    expect(solePlanting(PLANTS, 'tomato')).toBeNull()
  })
  it('returns null for a crop with none, for no crop, and for no list', () => {
    expect(solePlanting(PLANTS, 'squash')).toBeNull()
    expect(solePlanting(PLANTS, '')).toBeNull()
    expect(solePlanting(null, 'blueberry')).toBeNull()
  })
  it('ignores plantings with no variety_ref rather than throwing on them', () => {
    expect(plantingsForCrop(PLANTS, 'blueberry')).toHaveLength(1)
  })

  // ?view=picker returns archived_at rather than filtering in SQL, so each consumer filters it —
  // VoiceHarvest.jsx:340 and EventNew both do. Auto-attribution is the worst place to skip it: the
  // result is shown to the user as a stated fact ("✓ My garden · <name>"), so an archived planting
  // would be laundered into a decision rather than surfaced as a guess.
  const WITH_ARCHIVED = [
    { id: 'p-arch', archived_at: '2026-05-01T00:00:00Z', variety_ref: { crop_type_slug: 'garlic' } },
    { id: 'p-live', variety_ref: { crop_type_slug: 'garlic' } },
    { id: 'p-arch-only', archived_at: '2026-05-01T00:00:00Z', variety_ref: { crop_type_slug: 'leek' } },
  ]
  it('never auto-resolves onto an ARCHIVED planting, even when it is the only one for the crop', () => {
    expect(solePlanting(WITH_ARCHIVED, 'leek')).toBeNull()
  })
  it('resolves to the live planting when an archived sibling shares the crop, instead of declining', () => {
    expect(solePlanting(WITH_ARCHIVED, 'garlic').id).toBe('p-live')
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
