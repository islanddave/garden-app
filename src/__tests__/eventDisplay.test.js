// BUG-LOSSEVENTLABEL-001 — what an event row says about itself (src/lib/eventDisplay.js).
//
// Dave logged 2 of 8 Mini Roses lost (prod event 6dffa249, metadata {loss_reason:'weather',
// qty_reduced:2}) and the planting's log said "failed": too dramatic for a partial loss, and the same
// word as the planting STATUS. These pin the new wording and — just as important — that no OTHER
// type's wording moved.
import { describe, it, expect } from 'vitest'
import { eventTypeText, eventTitle, reductionCount, reductionReasonText } from '../lib/eventDisplay.js'
import {
  EVENT_TYPES, EVENT_TYPE_META, PLANT_REDUCTION_EVENT_TYPES, LOSS_REASONS, GIVEAWAY_REASONS,
  REDUCTION_REASON_LABELS,
} from '../lib/eventTypes.js'

const loss = (metadata, extra = {}) => ({ event_type: 'failed', title: null, metadata, ...extra })
const gift = (metadata, extra = {}) => ({ event_type: 'given_away', title: null, metadata, ...extra })

describe('eventTypeText — the type alone', () => {
  it('the two reduction types speak in the words they are picked by', () => {
    expect(eventTypeText('failed')).toBe('plants lost')
    expect(eventTypeText('given_away')).toBe('plants given away')
  })

  it('and match the picker label, so one event is never named two ways', () => {
    for (const t of PLANT_REDUCTION_EVENT_TYPES) {
      expect(eventTypeText(t)).toBe(EVENT_TYPE_META[t].label.toLowerCase())
    }
  })

  it('never says "fail" — Failed is a planting status, not an event', () => {
    for (const t of EVENT_TYPES) expect(eventTypeText(t), t).not.toMatch(/fail/i)
  })

  it('every OTHER type reads exactly as before: the de-snaked token', () => {
    const others = EVENT_TYPES.filter((t) => !PLANT_REDUCTION_EVENT_TYPES.includes(t))
    // Non-vacuity: the vocabulary is ~51 types; an empty filter would pass everything below.
    expect(others.length).toBeGreaterThan(40)
    for (const t of others) expect(eventTypeText(t), t).toBe(t.replace(/_/g, ' '))
  })

  it('free text and nothing', () => {
    expect(eventTypeText('flag_issue')).toBe('flag issue')
    expect(eventTypeText(null)).toBe('')
    expect(eventTypeText(undefined)).toBe('')
  })
})

describe('eventTitle — the row headline', () => {
  it("Dave's Mini Rose row reads '2 plants lost'", () => {
    expect(eventTitle(loss({ loss_reason: 'weather', qty_reduced: 2 }))).toBe('2 plants lost')
  })

  it('singular and plural, both types', () => {
    expect(eventTitle(loss({ loss_reason: 'pest', qty_reduced: 1 }))).toBe('1 plant lost')
    expect(eventTitle(loss({ loss_reason: 'pest', qty_reduced: 11 }))).toBe('11 plants lost')
    expect(eventTitle(gift({ giveaway_reason: 'friend', qty_reduced: 1 }))).toBe('1 plant given away')
    expect(eventTitle(gift({ giveaway_reason: 'friend', qty_reduced: 3 }))).toBe('3 plants given away')
  })

  it("the user's own title always wins", () => {
    expect(eventTitle(loss({ qty_reduced: 2 }, { title: 'Frost got the two by the door' })))
      .toBe('Frost got the two by the door')
  })

  it('no usable count falls back to the uncounted phrase, never NaN or "0 plants"', () => {
    for (const bad of [undefined, null, 0, -2, 2.5, 'abc', '']) {
      expect(eventTitle(loss({ qty_reduced: bad })), String(bad)).toBe('plants lost')
    }
    expect(eventTitle(loss(null))).toBe('plants lost')
    expect(eventTitle({ event_type: 'failed' })).toBe('plants lost')
  })

  it('a numeric string count still reads (jsonb round-trips are not type-stable)', () => {
    expect(eventTitle(loss({ qty_reduced: '2' }))).toBe('2 plants lost')
  })

  it('a qty_reduced key on any other type is ignored — only reductions are counted', () => {
    expect(eventTitle({ event_type: 'watering', metadata: { qty_reduced: 2 } })).toBe('watering')
    expect(reductionCount({ event_type: 'watering', metadata: { qty_reduced: 2 } })).toBeNull()
  })

  it('untitled ordinary events are unchanged', () => {
    expect(eventTitle({ event_type: 'brought_inside', title: null })).toBe('brought inside')
    expect(eventTitle({ event_type: 'brought_inside', title: '' })).toBe('brought inside')
  })
})

describe('reductionReasonText — why the count went down', () => {
  it('reads the chip caption the reason was picked from', () => {
    expect(reductionReasonText(loss({ loss_reason: 'weather', qty_reduced: 2 }))).toBe('Weather')
    expect(reductionReasonText(loss({ loss_reason: 'unknown', qty_reduced: 1 }))).toBe('Not sure')
    expect(reductionReasonText(gift({ giveaway_reason: 'community', qty_reduced: 1 }))).toBe('Shared locally')
  })

  it('every reason in both vocabularies has a caption (no raw token reaches the row)', () => {
    for (const r of LOSS_REASONS) expect(reductionReasonText(loss({ loss_reason: r })), r).toBe(REDUCTION_REASON_LABELS[r])
    for (const r of GIVEAWAY_REASONS) expect(reductionReasonText(gift({ giveaway_reason: r })), r).toBe(REDUCTION_REASON_LABELS[r])
  })

  it("reads only its own type's key — a gift reason never labels a loss", () => {
    expect(reductionReasonText(loss({ giveaway_reason: 'friend' }))).toBeNull()
    expect(reductionReasonText(gift({ loss_reason: 'pest' }))).toBeNull()
  })

  it('null for everything else', () => {
    expect(reductionReasonText({ event_type: 'watering', metadata: { loss_reason: 'pest' } })).toBeNull()
    expect(reductionReasonText(loss(null))).toBeNull()
    expect(reductionReasonText(null)).toBeNull()
  })
})
