import { describe, it, expect } from 'vitest'
import { severityTier, SEVERITY_STYLES, overdueLabel } from '../lib/waterDue.js'

const iso = (daysOver) => new Date(Date.now() - daysOver * 86400000).toISOString()

describe('waterDue severity (single source of truth)', () => {
  it('gold when <1 day over (outdoor)', () => expect(severityTier(iso(0.5), 'outdoor')).toBe('gold'))
  it('terra when 1-3 days over', () => expect(severityTier(iso(2), 'outdoor')).toBe('terra'))
  it('terra-bold when >=3 days over', () => expect(severityTier(iso(4), 'outdoor')).toBe('terra-bold'))
  it('indoor seedlings escalate to terra-bold at >=1 day', () => expect(severityTier(iso(1.5), 'indoor_seedling')).toBe('terra-bold'))
  it('every tier has a style', () => {
    ['green', 'gold', 'terra', 'terra-bold'].forEach(t => expect(SEVERITY_STYLES[t]).toBeDefined())
  })
  it('overdueLabel reads naturally', () => {
    expect(overdueLabel(iso(0))).toBe('due today')
    expect(overdueLabel(iso(1))).toBe('1 day overdue')
    expect(overdueLabel(iso(5))).toMatch(/5 days overdue/)
  })
})
