// V5-INFLIGHTBATCH-001 — the start resolver behind Snap's "Something in the kitchen" card.
//
// WHAT THIS FILE GUARDS is a frozen mapping and a DB biconditional, in that order.
//
// The mapping (API-CONTRACT §3.5) is not this module's to choose: seven chips resolve to
// exact|day|day|week|week|unknown|day, and the whole ruling is that precision is DERIVED from the
// tap rather than asked for. A relabel, a reorder or a remap is a contract break even though every
// individual value still parses, so the table is asserted whole rather than sampled.
//
// The biconditional is chk_kitchen_batch_start_pairing:
//   (started_at IS NOT NULL) = (start_precision IS NOT NULL AND start_precision <> 'unknown')
// Postgres enforces it, so a payload that breaks it is an opaque 500 rather than a validation
// message. It is swept across every chip AND both no-chip paths, because the two null-start states
// ("never asked" vs "asked, doesn't know") are DIFFERENT CLAIMS that the schema is deliberately
// three-valued about — and a spot check on one of them cannot tell them apart.
//
// `now` and picked dates are passed as ZONELESS LOCAL literals (new Date(y, m, d, ...)), never as
// millisecond offsets: CI's blocking TZ=America/New_York re-run is vacuous over offsets, which are
// TZ-invariant by construction. Both sides of each assertion are built the same way, so the literals
// hold in either lane while a UTC-based implementation fails the ET one.
// Lands on the `npm test` lane (vitest run --coverage) and on the TZ re-run. No jest-dom (L-182).
import { describe, it, expect } from 'vitest'
import { START_CHIPS, resolveStart, isPackTime } from '../components/kitchen/StartChips.jsx'

// 21:30 local: late enough that the UTC calendar date is ALREADY TOMORROW in America/New_York, so
// day arithmetic done through toISOString().slice(0,10) lands one day early and the TZ lane catches
// it. In the UTC lane the same literal is simply a normal evening.
const EVENING = () => new Date(2026, 7, 13, 21, 30, 0, 0)   // 2026-08-13 21:30 local
const MORNING = () => new Date(2026, 4, 2, 6, 5, 0, 0)      // 2026-05-02 06:05 local

const startOf = (chip, extra = {}) => resolveStart({ chip, now: EVENING(), ...extra })
const pairingHolds = (r) =>
  (r.started_at !== null) === (r.start_precision !== null && r.start_precision !== 'unknown')

describe('kitchen start — the frozen chip vocabulary (V5-INFLIGHTBATCH-001)', () => {
  it('is exactly the seven chips of the contract, in order, with the contract precisions', () => {
    // Full literal, both columns, all seven rows. The contract's own line is
    //   [Today] [Yesterday] [A few days ago] [About a week] [2–3 weeks] [Longer / not sure] [Pick a date]
    //   → exact|day|day|week|week|unknown|day
    expect(START_CHIPS.map(c => [c.id, c.label, c.precision])).toEqual([
      ['today',     'Today',             'exact'],
      ['yesterday', 'Yesterday',         'day'],
      ['fewdays',   'A few days ago',    'day'],
      ['aboutweek', 'About a week',      'week'],
      ['twoweeks',  '2–3 weeks',         'week'],
      ['longer',    'Longer / not sure', 'unknown'],
      ['pickdate',  'Pick a date',       'day'],
    ])
  })

  it('never exposes a precision the CHECK constraint would refuse', () => {
    // chk_kitchen_batch_start_precision: exact|hour|day|week|month|unknown.
    const allowed = ['exact', 'hour', 'day', 'week', 'month', 'unknown']
    for (const c of START_CHIPS) expect(allowed).toContain(c.precision)
  })
})

describe('kitchen start — resolveStart honours the DB biconditional (V5-INFLIGHTBATCH-001)', () => {
  it('holds for every chip, for the photo default, and for never-asked', () => {
    // SWEEP, not a spot check: the pairing is what makes a payload insertable at all, so every path
    // that can produce one is walked.
    for (const c of START_CHIPS) {
      const r = startOf(c.id, { pickedDate: '2026-08-01' })
      expect({ chip: c.id, ok: pairingHolds(r) }).toEqual({ chip: c.id, ok: true })
    }
    expect(pairingHolds(resolveStart({ now: EVENING(), photoTakenAt: '2026-08-01T14:00:00.000Z', photoId: 'ph-1' }))).toBe(true)
    expect(pairingHolds(resolveStart({ now: EVENING() }))).toBe(true)
  })

  it('distinguishes "asked, does not know" from "never asked" — different claims, both null-dated', () => {
    // The one pair a single test cannot separate, so they are asserted side by side as full objects.
    expect(startOf('longer')).toEqual({
      started_at: null, start_precision: 'unknown', start_anchor_kind: null, start_anchor_id: null,
    })
    expect(resolveStart({ now: EVENING() })).toEqual({
      started_at: null, start_precision: null, start_anchor_kind: null, start_anchor_id: null,
    })
  })

  it('lets an explicit "not sure" beat the photo — a stated unknown is not a gap to backfill', () => {
    expect(resolveStart({ chip: 'longer', now: EVENING(), photoTakenAt: '2026-08-01T14:00:00.000Z', photoId: 'ph-1' })).toEqual({
      started_at: null, start_precision: 'unknown', start_anchor_kind: null, start_anchor_id: null,
    })
  })
})

describe('kitchen start — the dates each chip resolves to (V5-INFLIGHTBATCH-001)', () => {
  it('"Today" is the instant, graded exact', () => {
    expect(startOf('today')).toEqual({
      started_at: EVENING().toISOString(), start_precision: 'exact',
      start_anchor_kind: 'memory', start_anchor_id: null,
    })
  })

  it('back-dates to LOCAL midnight n days ago, at two different clocks', () => {
    // TWO AGES, and the second is in a different month and a different DST offset — a single age
    // cannot tell a correct offset from a coincidence.
    expect(resolveStart({ chip: 'yesterday', now: EVENING() })).toEqual({
      started_at: new Date(2026, 7, 12).toISOString(), start_precision: 'day',
      start_anchor_kind: 'memory', start_anchor_id: null,
    })
    expect(resolveStart({ chip: 'yesterday', now: MORNING() })).toEqual({
      started_at: new Date(2026, 4, 1).toISOString(), start_precision: 'day',
      start_anchor_kind: 'memory', start_anchor_id: null,
    })
  })

  it('walks the whole back-dating row — both bounds and the two in between', () => {
    // BOTH BOUNDS: the nearest relative chip (yesterday, 1 d) and the furthest (2–3 weeks, 18 d),
    // plus the midpoints, so an off-by-one in any single row cannot hide behind its neighbours.
    expect(resolveStart({ chip: 'fewdays',   now: EVENING() }).started_at).toBe(new Date(2026, 7, 9).toISOString())
    expect(resolveStart({ chip: 'aboutweek', now: EVENING() }).started_at).toBe(new Date(2026, 7, 6).toISOString())
    expect(resolveStart({ chip: 'twoweeks',  now: EVENING() }).started_at).toBe(new Date(2026, 6, 26).toISOString())
    expect(resolveStart({ chip: 'twoweeks',  now: EVENING() }).start_precision).toBe('week')
  })

  it('"Pick a date" parses as a LOCAL calendar day, not as UTC', () => {
    const r = resolveStart({ chip: 'pickdate', pickedDate: '2026-08-13', now: EVENING() })
    expect(r).toEqual({
      started_at: new Date(2026, 7, 13).toISOString(), start_precision: 'day',
      start_anchor_kind: 'manual', start_anchor_id: null,
    })
    // The assertion above is stable in both TZ lanes because both sides are built locally; THIS one
    // is what a `new Date('2026-08-13')` UTC parse fails west of Greenwich — it lands on the 12th.
    expect(new Date(r.started_at).getDate()).toBe(13)
  })

  it('"Pick a date" left empty is not a claim — it falls through to the photo default', () => {
    expect(resolveStart({ chip: 'pickdate', pickedDate: '', now: EVENING(), photoTakenAt: '2026-08-01T14:00:00.000Z', photoId: 'ph-7' })).toEqual({
      started_at: '2026-08-01T14:00:00.000Z', start_precision: 'day',
      start_anchor_kind: 'photo', start_anchor_id: 'ph-7',
    })
    expect(resolveStart({ chip: 'pickdate', pickedDate: 'not-a-date', now: EVENING() })).toEqual({
      started_at: null, start_precision: null, start_anchor_kind: null, start_anchor_id: null,
    })
  })
})

describe('kitchen start — the photo default (V5-INFLIGHTBATCH-001)', () => {
  it('anchors to photos.taken_at at DAY precision, carrying the photo id', () => {
    // `day`, never `exact`/`hour`: taken_at is a zone-less capture time reinterpreted in whatever
    // zone the browser was in, so the hour is not trustworthy even when the day is.
    expect(resolveStart({ now: EVENING(), photoTakenAt: '2026-08-13T18:22:31.000Z', photoId: 'ph-1' })).toEqual({
      started_at: '2026-08-13T18:22:31.000Z', start_precision: 'day',
      start_anchor_kind: 'photo', start_anchor_id: 'ph-1',
    })
  })

  it('treats an unparseable taken_at as absent rather than writing an Invalid Date', () => {
    expect(resolveStart({ now: EVENING(), photoTakenAt: 'sometime last week', photoId: 'ph-1' })).toEqual({
      started_at: null, start_precision: null, start_anchor_kind: null, start_anchor_id: null,
    })
  })

  it('keeps the anchor legal when the photo has a time but no id', () => {
    // chk_kitchen_batch_anchor_pairing is one-directional: an id needs a kind, a kind needs no id.
    const r = resolveStart({ now: EVENING(), photoTakenAt: '2026-08-13T18:22:31.000Z', photoId: null })
    expect(r.start_anchor_kind).toBe('photo')
    expect(r.start_anchor_id).toBe(null)
  })
})

describe('kitchen start — isPackTime gates the salt ask (V5-INFLIGHTBATCH-001)', () => {
  it('is true for the untouched default and for Today, false for every back-date', () => {
    expect(isPackTime({ chip: null, now: EVENING() })).toBe(true)
    expect(isPackTime({ chip: 'today', now: EVENING() })).toBe(true)
    for (const chip of ['yesterday', 'fewdays', 'aboutweek', 'twoweeks', 'longer']) {
      expect({ chip, pack: isPackTime({ chip, now: EVENING() }) }).toEqual({ chip, pack: false })
    }
  })

  it('reads a picked date as pack time only when it IS today, locally', () => {
    expect(isPackTime({ chip: 'pickdate', pickedDate: '2026-08-13', now: EVENING() })).toBe(true)
    expect(isPackTime({ chip: 'pickdate', pickedDate: '2026-08-12', now: EVENING() })).toBe(false)
    expect(isPackTime({ chip: 'pickdate', pickedDate: '', now: EVENING() })).toBe(false)
  })
})
