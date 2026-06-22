// V3-STATUS-001: 'preparing' project status (bed-prep stage between planning and seeding).
import { describe, it, expect } from 'vitest'
import { PROJECT_STATUSES, PROJECT_STATUS_MAP, LOGGABLE_PROJECT_STATUSES, statusLabel } from '../lib/constants.js'
import { getStatusColors, STATUS_COLORS } from '../lib/status.js'

describe("V3-STATUS-001 'preparing' project status", () => {
  it('is in PROJECT_STATUSES, positioned between planning and seeding', () => {
    expect(PROJECT_STATUSES).toContain('preparing')
    expect(PROJECT_STATUSES.indexOf('preparing')).toBe(PROJECT_STATUSES.indexOf('planning') + 1)
    expect(PROJECT_STATUSES.indexOf('preparing')).toBeLessThan(PROJECT_STATUSES.indexOf('seeding'))
  })
  it('renders a label + is humanized', () => {
    expect(PROJECT_STATUS_MAP.preparing.label).toBe('Preparing')
    expect(statusLabel('preparing')).toBe('Preparing')
  })
  it('has its own badge color (not the planning fallback)', () => {
    expect(STATUS_COLORS.preparing).toBeDefined()
    expect(getStatusColors('preparing')).toEqual(STATUS_COLORS.preparing)
    expect(getStatusColors('preparing')).not.toEqual(getStatusColors('planning'))
  })
  it('is loggable (active lifecycle stage stays in the EventNew picker)', () => {
    expect(LOGGABLE_PROJECT_STATUSES).toContain('preparing')
  })
})
