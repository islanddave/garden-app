// src/__tests__/loggableProjectStatuses.test.js
// E3 (Dave directive 2026-06-04): "You can ABSOLUTELY harvest multiple times. That should
// absolutely not be the end of the process." A 'harvested' project MUST remain in the
// event-logging picker (EventNew); only 'ended' (truly done) stays excluded. Guards against
// the lettuce-harvesting regression where a harvested project vanished from the picker.
import { describe, it, expect } from 'vitest'
import { LOGGABLE_PROJECT_STATUSES, PROJECT_STATUSES } from '../lib/constants.js'

describe('LOGGABLE_PROJECT_STATUSES — repeatable harvest (E3)', () => {
  it("includes 'harvested' so a harvested project stays loggable", () => {
    expect(LOGGABLE_PROJECT_STATUSES).toContain('harvested')
  })
  it("excludes 'ended' (deliberate terminal — not loggable)", () => {
    expect(LOGGABLE_PROJECT_STATUSES).not.toContain('ended')
  })
  it('still includes every active lifecycle stage', () => {
    for (const s of PROJECT_STATUSES) expect(LOGGABLE_PROJECT_STATUSES).toContain(s)
  })
  it('the EventNew filter predicate keeps harvesting + harvested, drops ended', () => {
    const projects = [
      { id: 'a', status: 'harvesting' },
      { id: 'b', status: 'harvested' },
      { id: 'c', status: 'ended' },
    ]
    const loggable = projects.filter(p => LOGGABLE_PROJECT_STATUSES.includes(p.status))
    expect(loggable.map(p => p.id)).toEqual(['a', 'b'])
  })
})
