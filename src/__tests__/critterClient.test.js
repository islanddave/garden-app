/**
 * src/__tests__/critterClient.test.js
 * Fire-and-forget critter award client.
 *
 * Covers:
 *   - awardCritter no-ops when VITE_API_CRITTERS is unset
 *   - awardCritter no-ops when sourceEventId missing
 *   - awardCritter swallows fetch errors (NEVER rejects)
 *   - awardCritter POSTs body with species_id from pickSpecies + meta seed
 *   - awardCritter returns null on 204 (MVP plant-only scope)
 *   - fetchActiveCritters returns [] on no-op / failure
 *   - markCrittersViewed sends the x-garden-view-opened-at race-window header
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('awardCritter — VITE_API_CRITTERS unset (test env default)', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('no-ops without calling fetch when env var is empty', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { awardCritter } = await import('../lib/critterClient.js')
    const getToken = vi.fn().mockResolvedValue('tok')
    const result = await awardCritter({
      getToken,
      sourceEventId: '00000000-0000-0000-0000-000000000001',
    })
    expect(result).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('awardCritter — endpoint configured', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

  async function fresh() {
    vi.stubEnv('VITE_API_CRITTERS', 'https://critter.test/')
    vi.resetModules()
    return await import('../lib/critterClient.js')
  }

  it('POSTs body with deterministic species_id + auth header', async () => {
    const { awardCritter } = await fresh()
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ critter: { id: 'c1', species_id: 3 } }),
    })
    vi.stubGlobal('fetch', fetchSpy)
    const getToken = vi.fn().mockResolvedValue('tok-xyz')
    const res = await awardCritter({
      getToken,
      sourceEventId: '11111111-1111-1111-1111-111111111111',
      plantId: '22222222-2222-2222-2222-222222222222',
      eventCreatedAt: '2026-05-28T19:00:00Z',
      householdId: 'user_abc',
    })
    expect(res.critter.id).toBe('c1')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://critter.test/api/critters')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer tok-xyz')
    expect(opts.headers['x-client-tz-offset']).toBeDefined()
    expect(opts.keepalive).toBe(true)
    const body = JSON.parse(opts.body)
    expect(body.source_event_id).toBe('11111111-1111-1111-1111-111111111111')
    expect(body.plant_id).toBe('22222222-2222-2222-2222-222222222222')
    expect(Number.isInteger(body.species_id)).toBe(true)
    expect(body.species_id).toBeGreaterThanOrEqual(3) // earned pool
    expect(body.species_id).toBeLessThanOrEqual(8)
    expect(body.meta.deterministic_seed).toContain('11111111')
    expect(Number.isInteger(body.meta.copy_variant_id)).toBe(true)
  })

  it('returns null on 204 (MVP plant-only scope cut)', async () => {
    const { awardCritter } = await fresh()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204, json: () => null }))
    const res = await awardCritter({
      getToken: () => Promise.resolve('tok'),
      sourceEventId: '33333333-3333-3333-3333-333333333333',
    })
    expect(res).toBeNull()
  })

  it('NEVER rejects when fetch throws — returns null', async () => {
    const { awardCritter } = await fresh()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const res = await awardCritter({
      getToken: () => Promise.resolve('tok'),
      sourceEventId: '44444444-4444-4444-4444-444444444444',
    })
    expect(res).toBeNull()
  })

  it('no-ops without sourceEventId', async () => {
    const { awardCritter } = await fresh()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const res = await awardCritter({ getToken: () => Promise.resolve('tok') })
    expect(res).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('idempotent response (200 + idempotent=true) passes through', async () => {
    const { awardCritter } = await fresh()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ critter: { id: 'c1', species_id: 5 }, idempotent: true }),
    }))
    const res = await awardCritter({
      getToken: () => Promise.resolve('tok'),
      sourceEventId: '55555555-5555-5555-5555-555555555555',
    })
    expect(res.critter.id).toBe('c1')
    expect(res.idempotent).toBe(true)
  })
})

describe('fetchActiveCritters', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

  it('returns [] when endpoint unset', async () => {
    const { fetchActiveCritters } = await import('../lib/critterClient.js')
    expect(await fetchActiveCritters({ getToken: () => Promise.resolve('tok') })).toEqual([])
  })

  it('returns critters array on 200', async () => {
    vi.stubEnv('VITE_API_CRITTERS', 'https://critter.test/')
    vi.resetModules()
    const { fetchActiveCritters } = await import('../lib/critterClient.js')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ critters: [{ id: 'a' }, { id: 'b' }] }),
    }))
    const res = await fetchActiveCritters({ getToken: () => Promise.resolve('tok') })
    expect(res).toHaveLength(2)
  })

  it('returns [] on fetch error (never throws)', async () => {
    vi.stubEnv('VITE_API_CRITTERS', 'https://critter.test/')
    vi.resetModules()
    const { fetchActiveCritters } = await import('../lib/critterClient.js')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const res = await fetchActiveCritters({ getToken: () => Promise.resolve('tok') })
    expect(res).toEqual([])
  })
})

describe('markCrittersViewed', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

  it('sends x-garden-view-opened-at header for race-window guard', async () => {
    vi.stubEnv('VITE_API_CRITTERS', 'https://critter.test/')
    vi.resetModules()
    const { markCrittersViewed } = await import('../lib/critterClient.js')
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ marked_viewed_ids: ['a'] }),
    })
    vi.stubGlobal('fetch', fetchSpy)
    const opened = '2026-05-28T19:00:00.000Z'
    const res = await markCrittersViewed({ getToken: () => Promise.resolve('tok'), openedAt: opened })
    expect(res).toEqual(['a'])
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://critter.test/api/critters/viewed')
    expect(opts.method).toBe('PATCH')
    expect(opts.headers['x-garden-view-opened-at']).toBe(opened)
  })
})

describe('patchSpeciesPrefs (D-INV-1)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

  it('returns null when endpoint unset', async () => {
    const { patchSpeciesPrefs } = await import('../lib/critterClient.js')
    const res = await patchSpeciesPrefs({ getToken: () => Promise.resolve('tok'), speciesId: 3, weight: 2.0 })
    expect(res).toBeNull()
  })

  it('returns null on invalid speciesId (out of [1,8])', async () => {
    vi.stubEnv('VITE_API_CRITTERS', 'https://critter.test/')
    vi.resetModules()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { patchSpeciesPrefs } = await import('../lib/critterClient.js')
    expect(await patchSpeciesPrefs({ getToken: () => Promise.resolve('tok'), speciesId: 9, weight: 2.0 })).toBeNull()
    expect(await patchSpeciesPrefs({ getToken: () => Promise.resolve('tok'), speciesId: 0, weight: 2.0 })).toBeNull()
    expect(await patchSpeciesPrefs({ getToken: () => Promise.resolve('tok'), speciesId: 'x', weight: 2.0 })).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns null on invalid weight (≤0 or non-finite)', async () => {
    vi.stubEnv('VITE_API_CRITTERS', 'https://critter.test/')
    vi.resetModules()
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const { patchSpeciesPrefs } = await import('../lib/critterClient.js')
    expect(await patchSpeciesPrefs({ getToken: () => Promise.resolve('tok'), speciesId: 3, weight: 0 })).toBeNull()
    expect(await patchSpeciesPrefs({ getToken: () => Promise.resolve('tok'), speciesId: 3, weight: -1 })).toBeNull()
    expect(await patchSpeciesPrefs({ getToken: () => Promise.resolve('tok'), speciesId: 3, weight: NaN })).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('PATCHes /api/critters/species-prefs with body + auth header', async () => {
    vi.stubEnv('VITE_API_CRITTERS', 'https://critter.test/')
    vi.resetModules()
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ species_id: 3, weight: 2.0, set_at: '2026-05-28T00:00:00Z' }),
    })
    vi.stubGlobal('fetch', fetchSpy)
    const { patchSpeciesPrefs } = await import('../lib/critterClient.js')
    const res = await patchSpeciesPrefs({ getToken: () => Promise.resolve('tok-abc'), speciesId: 3, weight: 2.0 })
    expect(res.species_id).toBe(3)
    expect(res.weight).toBe(2.0)
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://critter.test/api/critters/species-prefs')
    expect(opts.method).toBe('PATCH')
    expect(opts.headers.Authorization).toBe('Bearer tok-abc')
    const body = JSON.parse(opts.body)
    expect(body.species_id).toBe(3)
    expect(body.weight).toBe(2.0)
  })

  it('NEVER rejects on fetch error', async () => {
    vi.stubEnv('VITE_API_CRITTERS', 'https://critter.test/')
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const { patchSpeciesPrefs } = await import('../lib/critterClient.js')
    const res = await patchSpeciesPrefs({ getToken: () => Promise.resolve('tok'), speciesId: 5, weight: 0.5 })
    expect(res).toBeNull()
  })
})
