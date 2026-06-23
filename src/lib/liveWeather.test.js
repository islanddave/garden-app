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
  it('treats missing pop as null and coerces non-finite precip to 0', () => {
    const h = mapOpenMeteoDailyToHydrology({ daily: { precipitation_sum: [null, 0.03, 0.6, 0.2, 0.1], precipitation_probability_max: [] } })
    expect(h.today_pop).toBeNull()
    expect(h.recent_precip_in).toBe(0.03)
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
