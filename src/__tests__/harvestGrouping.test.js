import { describe, it, expect } from 'vitest'
import { groupByDay, dayLabel } from '../lib/harvestGrouping.js'

describe('groupByDay', () => {
  it('groups entries by day_key, preserving feed order across and within days', () => {
    const entries = [
      { event_id: 'a', day_key: '2026-07-20' },
      { event_id: 'b', day_key: '2026-07-20' },
      { event_id: 'c', day_key: '2026-07-19' },
    ]
    const secs = groupByDay(entries)
    expect(secs.map((s) => s.day_key)).toEqual(['2026-07-20', '2026-07-19'])
    expect(secs[0].entries.map((e) => e.event_id)).toEqual(['a', 'b'])
    expect(secs[1].entries.map((e) => e.event_id)).toEqual(['c'])
  })
  it('falls back to the event_date date-part when day_key is missing', () => {
    const secs = groupByDay([{ event_id: 'x', event_date: '2026-06-01T12:00:00Z' }])
    expect(secs[0].day_key).toBe('2026-06-01')
  })
  it('returns [] for empty input', () => expect(groupByDay([])).toEqual([]))
})

describe('dayLabel', () => {
  it('omits the year within the current year', () => {
    const label = dayLabel('2026-07-20', 2026)
    expect(label).not.toMatch(/2026/)
    expect(label).toMatch(/Jul/)
  })
  it('shows the year outside the current year', () => {
    expect(dayLabel('2025-11-03', 2026)).toMatch(/2025/)
  })
  it('passes a non-date string through unchanged', () => {
    expect(dayLabel('unknown', 2026)).toBe('unknown')
  })
})
