import { describe, it, expect, vi } from 'vitest'
import { mapOpenMeteoDailyToHydrology, fetchLiveRain, OPEN_METEO_PRECIP_URL } from './liveWeather.js'

const daily = {
  precipitation_sum: [0.02, 0.03, 0.61, 0.20, 0.10], // [D-2,D-1,D0,D1,D2]
  precipitation_probability_max: [10, 20, 92, 30, 15],
}

describe('mapOpenMeteoDailyToHydrology', () => {
  it('mirrors the engine fetchPrecip mapping (D0 today, D1 tomorrow, recent/upcoming sums, round2)', () => {
    const h = mapOpenMeteoDailyToHydrology({ daily })
    expect(h.today_precip_in).toBe(0.61)
    expect(h.today_pop).toBe(92)
    expect(h.tomorrow_precip_in).toBe(0.2)
    expect(h.tomorrow_pop).toBe(30)
    expect(h.recent_precip_in).toBe(0.05)  // 0.02 + 0.03
    expect(h.upcoming_precip_in).toBe(0.3) // 0.20 + 0.10
  })
  it('returns null on a malformed payload (too few days / no daily)', () => {
    expect(mapOpenMeteoDailyToHydrology(null)).toBeNull()
    expect(mapOpenMeteoDailyToHydrology({})).toBeNull()
    expect(mapOpenMeteoDailyToHydrology({ daily: { precipitation_sum: [1, 2] } })).toBeNull()
  })
  it('treats missing pop as null', () => {
    const h = mapOpenMeteoDailyToHydrology({ daily: { precipitation_sum: [null, 0.03, 0.6, 0.2, 0.1], precipitation_probability_max: [] } })
    expect(h.today_pop).toBeNull()
    expect(h.tomorrow_pop).toBeNull()
  })

  // ── BUG-LIVEWEATHERNUMOR0-001 ─────────────────────────────────────────────────────────────────
  // The old mapping ran every precipitation value through `numOr0`, so null, undefined, a string and
  // NaN all became 0 — and any cue keyed on the figure fired HARDEST exactly when the forecast was
  // unavailable. That inversion is the defect. The proof it was a defect and not a decision is in
  // the same function: precipitation_probability_max has always preserved null. These tests pin the
  // two fields to the SAME rule.
  describe('absence is preserved, not fabricated as 0.00 in', () => {
    const map = (precipitation_sum, precipitation_probability_max = [10, 20, 92, 30, 15]) =>
      mapOpenMeteoDailyToHydrology({ daily: { precipitation_sum, precipitation_probability_max } })

    it('a null D0 gives a null today_precip_in, not a confident dry day', () => {
      const h = map([0.02, 0.03, null, 0.2, 0.1])
      expect(h.today_precip_in).toBeNull()
      // Everything that IS known still comes through — the field is nulled, not the payload.
      expect(h.tomorrow_precip_in).toBe(0.2)
      expect(h.today_pop).toBe(92)
    })

    it('precip and POP now answer the same way for the same missing day (the asymmetry is gone)', () => {
      const h = map([0.02, 0.03, null, null, 0.1], [10, 20, null, null, 15])
      expect(h.today_precip_in).toBeNull()
      expect(h.today_pop).toBeNull()
      expect(h.tomorrow_precip_in).toBeNull()
      expect(h.tomorrow_pop).toBeNull()
    })

    it('a sum with one unknown term is unknown — not the other term on its own', () => {
      // 0.03 was reported as "0.03 inches fell over the last two days", which is an understatement
      // dressed as a measurement. D-2 is not known, so the two-day total is not known.
      expect(map([null, 0.03, 0.6, 0.2, 0.1]).recent_precip_in).toBeNull()
      expect(map([0.02, null, 0.6, 0.2, 0.1]).recent_precip_in).toBeNull()
      expect(map([0.02, 0.03, 0.6, 0.2, 0.1]).recent_precip_in).toBe(0.05)
      // D2 absent entirely — the 4-element payload this function explicitly accepts.
      expect(map([0.02, 0.03, 0.6, 0.2]).upcoming_precip_in).toBeNull()
      expect(map([0.02, 0.03, 0.6, 0.2]).tomorrow_precip_in).toBe(0.2)
    })

    it('a non-number of any kind is absence, not zero', () => {
      // Open-Meteo has answered with strings before; NaN comes out of unit arithmetic upstream.
      for (const bad of ['0.61', undefined, NaN, {}, true]) {
        expect(map([0.02, 0.03, bad, 0.2, 0.1]).today_precip_in).toBeNull()
      }
    })

    it('a real zero is STILL a zero — absence and "it did not rain" stay distinguishable', () => {
      // The half that must not regress. If this returned null the fix would have traded one
      // fabrication for another.
      const h = map([0, 0, 0, 0, 0])
      expect(h.today_precip_in).toBe(0)
      expect(h.recent_precip_in).toBe(0)
      expect(h.upcoming_precip_in).toBe(0)
    })
  })
})

describe('fetchLiveRain', () => {
  const coords = { lat: 42.5, lng: -72.6 }
  it('returns { hydrology, refreshedAt } and hits the engine-identical URL on a good response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ daily }) })
    const r = await fetchLiveRain(coords, { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(OPEN_METEO_PRECIP_URL(42.5, -72.6), expect.anything())
    expect(r.hydrology.today_precip_in).toBe(0.61)
    expect(typeof r.refreshedAt).toBe('string')
  })
  it('returns null on no coords / http error / network throw / malformed body (never breaks Today)', async () => {
    expect(await fetchLiveRain(null, { fetchImpl: vi.fn() })).toBeNull()
    expect(await fetchLiveRain(coords, { fetchImpl: vi.fn().mockResolvedValue({ ok: false }) })).toBeNull()
    expect(await fetchLiveRain(coords, { fetchImpl: vi.fn().mockRejectedValue(new Error('net')) })).toBeNull()
    expect(await fetchLiveRain(coords, { fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) })).toBeNull()
  })
})
