import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

  describe('equivalence with the per-screen "today" forms that todayLocalISO replaced', () => {
    // Each form is the body of a retired local helper, kept verbatim so the swap is provably a no-op.
    const padForm = () => {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    const offsetForm = () => {
      const d = new Date()
      const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      return local.toISOString().slice(0, 10)
    }
    const INSTANTS = [
      '2026-03-08T04:59:59Z', // 23:59:59 EST the night before spring-forward
      '2026-03-08T05:00:00Z', // local midnight, spring-forward day
      '2026-03-08T06:59:59Z', // 01:59:59 EST, last second before the gap
      '2026-03-08T07:00:00Z', // 03:00 EDT, just after the gap
      '2026-11-01T03:59:59Z', // 23:59:59 EDT the night before fall-back
      '2026-11-01T04:00:00Z', // local midnight, fall-back day
      '2026-11-01T05:30:00Z', // 01:30 EDT, first pass through the repeated hour
      '2026-11-01T06:30:00Z', // 01:30 EST, second pass
      '2026-12-31T23:59:59Z',
      '2027-01-01T04:59:59Z',
      '2028-02-29T12:00:00Z',
    ]
    const ZONES = ['America/New_York', 'UTC', 'Asia/Tokyo', 'Pacific/Auckland', 'America/Los_Angeles']
    const priorTZ = process.env.TZ

    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => {
      vi.useRealTimers()
      if (priorTZ === undefined) delete process.env.TZ
      else process.env.TZ = priorTZ
    })

    for (const zone of ZONES) {
      it.each(INSTANTS)(`${zone} at %s`, (iso) => {
        process.env.TZ = zone
        vi.setSystemTime(new Date(iso))
        const canonical = todayLocalISO()
        expect(padForm()).toBe(canonical)
        expect(offsetForm()).toBe(canonical)
      })
    }

    it('the UTC slice is NOT equivalent near local midnight (the table can fail)', () => {
      process.env.TZ = 'America/New_York'
      vi.setSystemTime(new Date('2026-03-08T04:59:59Z'))
      expect(todayLocalISO()).toBe('2026-03-07')
      expect(new Date().toISOString().slice(0, 10)).toBe('2026-03-08')
    })
  })
})
