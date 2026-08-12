/**
 * src/__tests__/critterClient.test.js
 * Fire-and-forget critter award client.
 *
 * Covers:
 *   - fetchActiveCritters returns [] on no-op / failure
 *   - markCrittersViewed sends the x-garden-view-opened-at race-window header
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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

describe('markCrittersViewed — Session 3.5 actuallySeenCritterIds (§3.26)', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules() })

  async function fresh() {
    vi.stubEnv('VITE_API_CRITTERS', 'https://critter.test/')
    vi.resetModules()
    return await import('../lib/critterClient.js')
  }

  it('does NOT send body when actuallySeenCritterIds is null (bulk fallback)', async () => {
    const { markCrittersViewed } = await fresh()
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ marked_viewed_ids: ['x'] }) })
    vi.stubGlobal('fetch', fetchSpy)
    await markCrittersViewed({ getToken: () => Promise.resolve('tok') })
    const [, opts] = fetchSpy.mock.calls[0]
    expect(opts.body).toBeUndefined()
    expect(opts.headers['Content-Type']).toBeUndefined()
  })

  it('does NOT send body when actuallySeenCritterIds is empty array (bulk fallback)', async () => {
    const { markCrittersViewed } = await fresh()
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ marked_viewed_ids: [] }) })
    vi.stubGlobal('fetch', fetchSpy)
    await markCrittersViewed({ getToken: () => Promise.resolve('tok'), actuallySeenCritterIds: [] })
    const [, opts] = fetchSpy.mock.calls[0]
    expect(opts.body).toBeUndefined()
    expect(opts.headers['Content-Type']).toBeUndefined()
  })

  it('SENDS body when actuallySeenCritterIds is a non-empty array', async () => {
    const { markCrittersViewed } = await fresh()
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ marked_viewed_ids: ['c1', 'c2'] }) })
    vi.stubGlobal('fetch', fetchSpy)
    const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222']
    const res = await markCrittersViewed({
      getToken: () => Promise.resolve('tok'),
      openedAt: '2026-05-29T17:00:00.000Z',
      actuallySeenCritterIds: ids,
    })
    expect(res).toEqual(['c1', 'c2'])
    const [url, opts] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://critter.test/api/critters/viewed')
    expect(opts.method).toBe('PATCH')
    expect(opts.headers['x-garden-view-opened-at']).toBe('2026-05-29T17:00:00.000Z')
    expect(opts.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(opts.body)
    expect(body.actually_seen_critter_ids).toEqual(ids)
  })

  it('sets keepalive:true on the fetch init (survives unmount/visibility-change)', async () => {
    const { markCrittersViewed } = await fresh()
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ marked_viewed_ids: [] }) })
    vi.stubGlobal('fetch', fetchSpy)
    await markCrittersViewed({ getToken: () => Promise.resolve('tok') })
    const [, opts] = fetchSpy.mock.calls[0]
    expect(opts.keepalive).toBe(true)
  })

  it('NEVER rejects when fetch throws — returns []', async () => {
    const { markCrittersViewed } = await fresh()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('boom')))
    const res = await markCrittersViewed({
      getToken: () => Promise.resolve('tok'),
      actuallySeenCritterIds: ['11111111-1111-1111-1111-111111111111'],
    })
    expect(res).toEqual([])
  })
})
