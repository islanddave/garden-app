import { describe, it, expect } from 'vitest'
import { toLocalISO, todayLocalISO } from '../lib/dateLocal.js'

describe('dateLocal', () => {
  it('formats a local Date as YYYY-MM-DD (TZ-agnostic — uses local getters)', () => {
    // Constructed with the LOCAL Date constructor, so these assertions hold in any TZ.
    expect(toLocalISO(new Date(2026, 2, 14, 22, 0, 0))).toBe('2026-03-14') // 10pm local, still the 14th
    expect(toLocalISO(new Date(2026, 0, 5, 0, 0, 0))).toBe('2026-01-05')   // zero-pads month + day
    expect(toLocalISO(new Date(2026, 11, 31, 23, 59, 0))).toBe('2026-12-31')
  })

  it('does NOT roll forward like UTC does for a late-evening negative-offset instant', () => {
    // 2026-03-15T02:00:00Z is still 2026-03-14 in every UTC-negative zone (the Americas).
    // The buggy `toISOString().slice(0,10)` would return 2026-03-15; the local formatter must not.
    const d = new Date('2026-03-15T02:00:00Z')
    if (d.getTimezoneOffset() > 0) {
      // Runner is in a UTC-negative zone (e.g. CI's America/New_York) — assert no roll-forward.
      expect(toLocalISO(d)).toBe('2026-03-14')
    } else {
      // UTC/positive-offset runner: just assert the shape, the bug doesn't manifest here.
      expect(toLocalISO(d)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('todayLocalISO returns a well-formed local date', () => {
    expect(todayLocalISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})
