// The start resolver behind Snap's "Something in the kitchen" card.
//
// ⚠ RE-POINTED by Put-Up 1a item 5 (V4 §2.2, §8.3), in the same commit as the change. Snap's kitchen
// card used to carry its own seven-chip row (Today · Yesterday · A few days ago · About a week · 2–3
// weeks · Longer / not sure · Pick a date) and fell back to the photo's taken_at when nothing was
// tapped. It now opens THE shared Start sheet, whose row is Today (preselected) · Yesterday · Earlier…
// · Not sure, with Earlier… offering only what the live CHECK can store in 1a. This file keeps the
// same two jobs it always had — a frozen mapping and a DB biconditional — against the new resolver.
//
// The biconditional is chk_kitchen_batch_start_pairing:
//   (started_at IS NOT NULL) = (start_precision IS NOT NULL AND start_precision <> 'unknown')
// and the precision CHECK is chk_kitchen_batch_start_precision, READ LIVE on prod and staging
// 2026-09-29: exact · hour · day · week · month · unknown. Both are swept across every path.
//
// `now` and picked dates are ZONELESS LOCAL literals (new Date(y, m, d, ...)), never millisecond
// offsets: CI's blocking TZ=America/New_York re-run is vacuous over offsets.
// Lands on the `npm test` lane (vitest run --coverage) and on the TZ re-run. No jest-dom (L-182).
import { describe, it, expect } from 'vitest'
import { SHEET_START_CHIPS, EARLIER_CHIPS, START_ERRORS, resolveSheetStart } from '../components/kitchen/StartChips.jsx'

// 21:30 local: late enough that the UTC calendar date is ALREADY TOMORROW in America/New_York, so
// day arithmetic done through toISOString().slice(0,10) lands one day early and the TZ lane catches it.
const EVENING = () => new Date(2026, 7, 13, 21, 30, 0, 0)   // 2026-08-13 21:30 local
const MORNING = () => new Date(2026, 4, 2, 6, 5, 0, 0)      // 2026-05-02 06:05 local
// Release 1b widens chk_kitchen_batch_start_precision (v5-putupmake-001/0a): + season, year.
const LIVE_PRECISIONS = ['exact', 'hour', 'day', 'week', 'month', 'season', 'year', 'unknown']

const pairingHolds = (r) =>
  (r.started_at !== null) === (r.start_precision !== null && r.start_precision !== 'unknown')

const EVERY_PATH = [
  { chip: 'today' }, { chip: 'yesterday' }, { chip: 'unsure' },
  { chip: 'earlier', earlier: 'this_month' }, { chip: 'earlier', earlier: 'last_month' },
  { chip: 'earlier', earlier: 'two_three' }, { chip: 'earlier', earlier: 'earlier_year' },
  { chip: 'earlier', earlier: 'last_year' },
  { chip: 'earlier', earlier: 'pickdate', pickedDate: '2026-08-01' },
]

describe('kitchen start — the frozen chip vocabulary (Put-Up 1a)', () => {
  it('is exactly the four chips of the plan, in order, Today first', () => {
    expect(SHEET_START_CHIPS.map(c => [c.id, c.label])).toEqual([
      ['today', 'Today'], ['yesterday', 'Yesterday'], ['earlier', 'Earlier…'], ['unsure', 'Not sure'],
    ])
  })

  it('never exposes a precision the LIVE CHECK would refuse — including under Earlier…', () => {
    for (const c of [...SHEET_START_CHIPS, ...EARLIER_CHIPS]) {
      if (c.precision) expect({ chip: c.id, ok: LIVE_PRECISIONS.includes(c.precision) }).toEqual({ chip: c.id, ok: true })
    }
    // …and every path's RESOLVED precision too, not only the declared one.
    for (const p of EVERY_PATH) {
      const { start } = resolveSheetStart({ ...p, now: EVENING() })
      expect({ p, ok: LIVE_PRECISIONS.includes(start.start_precision) }).toEqual({ p, ok: true })
    }
  })
})

describe('kitchen start — resolveSheetStart honours the DB biconditional', () => {
  it('holds for every chip and every Earlier… choice', () => {
    for (const p of EVERY_PATH) {
      const { start } = resolveSheetStart({ ...p, now: EVENING() })
      expect({ p, ok: pairingHolds(start) }).toEqual({ p, ok: true })
    }
  })

  it('"Not sure" is "asked, does not know" — never the never-asked pair', () => {
    expect(resolveSheetStart({ chip: 'unsure', now: EVENING() }).start).toEqual({
      started_at: null, start_precision: 'unknown', start_anchor_kind: null, start_anchor_id: null,
    })
  })

  // The shipped card could store "never asked" (both null) by leaving every chip alone; the shared
  // sheet cannot — Today is preselected, and a half-answer is REFUSED rather than stored as a blank.
  it('refuses a half-answer instead of storing "never asked"', () => {
    expect(resolveSheetStart({ chip: 'earlier', now: EVENING() })).toEqual({ error: START_ERRORS.earlier })
    expect(resolveSheetStart({ chip: 'earlier', earlier: 'pickdate', pickedDate: '', now: EVENING() })).toEqual({ error: START_ERRORS.pickdate })
  })
})

describe('kitchen start — the dates each chip resolves to', () => {
  it('"Today" is the instant, graded exact', () => {
    expect(resolveSheetStart({ chip: 'today', now: EVENING() }).start).toEqual({
      started_at: EVENING().toISOString(), start_precision: 'exact', start_anchor_kind: 'memory', start_anchor_id: null,
    })
  })

  it('"Yesterday" back-dates to LOCAL midnight, at two different clocks', () => {
    // TWO AGES, in different months and DST offsets — a single age cannot tell a correct offset from a
    // coincidence.
    expect(resolveSheetStart({ chip: 'yesterday', now: EVENING() }).start).toEqual({
      started_at: new Date(2026, 7, 12).toISOString(), start_precision: 'day', start_anchor_kind: 'memory', start_anchor_id: null,
    })
    expect(resolveSheetStart({ chip: 'yesterday', now: MORNING() }).start.started_at).toBe(new Date(2026, 4, 1).toISOString())
  })

  it('"This month" and "Last month" store the START of their window, graded month', () => {
    expect(resolveSheetStart({ chip: 'earlier', earlier: 'this_month', now: EVENING() }).start)
      .toEqual({ started_at: new Date(2026, 7, 1).toISOString(), start_precision: 'month', start_anchor_kind: 'memory', start_anchor_id: null })
    expect(resolveSheetStart({ chip: 'earlier', earlier: 'last_month', now: MORNING() }).start.started_at)
      .toBe(new Date(2026, 3, 1).toISOString())
  })

  it('"Pick a date" parses as a LOCAL calendar day, not as UTC', () => {
    const { start } = resolveSheetStart({ chip: 'earlier', earlier: 'pickdate', pickedDate: '2026-08-13', now: EVENING() })
    expect(start).toEqual({
      started_at: new Date(2026, 7, 13).toISOString(), start_precision: 'day', start_anchor_kind: 'manual', start_anchor_id: null,
    })
    // What a `new Date('2026-08-13')` UTC parse fails west of Greenwich — it lands on the 12th.
    expect(new Date(start.started_at).getDate()).toBe(13)
  })

  // The retired default, pinned as GONE: the resolver takes no photo, so the photo's taken_at can no
  // longer choose the start. Today does, until the cook taps otherwise (V4 §6.3).
  it('has no photo input at all — the photo\'s date no longer decides the start', () => {
    const withPhoto = resolveSheetStart({ chip: 'today', now: EVENING(), photoTakenAt: '2026-08-01T14:00:00.000Z', photoId: 'ph-1' })
    expect(withPhoto.start.started_at).toBe(EVENING().toISOString())
    expect(withPhoto.start.start_anchor_kind).toBe('memory')
  })
})
