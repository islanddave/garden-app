// V4-OVERWINTER-001 — the SPA read path for the overwintering bucket.
// buildCareNeeded is the single source of truth for what Today renders, so an engine bucket that is
// not wired here is data nobody sees. Each assertion names the source mutation that turns it red.
import { describe, it, expect } from 'vitest'
import {
  buildCareNeeded, needReason, needTier, NEED_EVENT_TYPE, NEED_LABEL, NEED_ORDER,
} from '../lib/careNeeded.js'

const OW = {
  id: 'ow1', name: 'Winterbor Kale', crop: 'kale', project: 'Winter Bed', project_id: 'prW',
  regime: 'protected_productive', interval: 14, days_since: 60, overdue_by: 46, never: false,
  exit_due: false, reason: 'Overwintering — soil check due (60d since last water/check); water only if dry below the top inch',
}

describe('overwintering renders as a tappable care row', () => {
  // Mutation: remove 'overwintering' from NEED_ORDER and this goes red — the engine would still emit
  // the bucket and Today would show nothing, which is the silent-data failure mode.
  it('produces a row from the engine bucket', () => {
    const rows = buildCareNeeded({ water_due: [], overwintering: [OW] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      key: 'ow1:overwintering', plantingId: 'ow1', need: 'overwintering',
      eventType: 'moisture_check', name: 'Winterbor Kale', projectId: 'prW',
    })
    expect(rows[0].reason).toMatch(/water only if dry below the top inch/)
  })

  // A winter check logs a moisture_check, NOT a watering. Mutation: set NEED_EVENT_TYPE.overwintering
  // to 'watering' and this goes red — and the live consequence is a falsified last_water plus, in the
  // two quiescent regimes, a model taught to keep a cold pot wet.
  it('logs a moisture_check, never a watering', () => {
    expect(NEED_EVENT_TYPE.overwintering).toBe('moisture_check')
    expect(NEED_EVENT_TYPE.overwintering).not.toBe(NEED_EVENT_TYPE.water_due)
    expect(NEED_LABEL.overwintering).toBe('Check')
  })

  // It must sit LAST: a fortnightly-to-monthly check must never push a same-night freeze protection
  // down the page. Mutation: move it ahead of 'cold' in NEED_ORDER and this goes red.
  it('orders below every same-day need', () => {
    expect(NEED_ORDER[NEED_ORDER.length - 1]).toBe('overwintering')
    expect(NEED_ORDER.indexOf('overwintering')).toBeGreaterThan(NEED_ORDER.indexOf('cold'))
    const rows = buildCareNeeded({
      cold: [{ id: 'c1', name: 'Lime', text: 'Below 40 tonight' }],
      overwintering: [OW],
    })
    expect(rows.map((r) => r.need)).toEqual(['cold', 'overwintering'])
  })

  // The exit notice renders too, and reads as an instruction to move the plant rather than to water it.
  // Mutation: drop the exit_due branch from needReason and the fallback text goes red.
  it('renders the bounded exit notice', () => {
    const exitRow = { ...OW, id: 'ow2', exit_due: true, interval: null, days_since: null,
      reason: 'Overwintering window has ended — move it back out and resume normal care, or extend the window' }
    const rows = buildCareNeeded({ overwintering: [exitRow] })
    expect(rows[0].reason).toMatch(/move it back out/)
    expect(needReason('overwintering', { exit_due: true })).toBe('Overwintering window ended')
  })

  // A done item drops out, same as every other bucket — the read-time check-off has to reach it or the
  // card cannot be retired for the day.
  it('honours the read-time done stamp', () => {
    expect(buildCareNeeded({ overwintering: [{ ...OW, done: true }] })).toHaveLength(0)
  })

  // Not on an overdue clock in the same sense as watering: gold, never the terra escalation. A 46-day
  // "overdue" on a 14-day winter check must not out-shout a genuinely thirsty plant in July.
  it('never escalates past gold', () => {
    expect(needTier('overwintering', OW)).toBe('gold')
    expect(needTier('overwintering', { ...OW, overdue_by: 400 })).toBe('gold')
  })

  // Inertness: a plan with no overwintering key (the byte-identical payload the engine emits today)
  // must produce exactly the rows it did before this change.
  it('is inert for a plan that carries no overwintering key', () => {
    const rows = buildCareNeeded({ water_due: [{ id: 'p1', name: 'Pepper', overdue_by: 2 }] })
    expect(rows.map((r) => r.need)).toEqual(['water_due'])
  })
})
